//! Looking up the panel's name.
//!
//! Some routers leave a resolver very little patience: Keenetic writes
//! `options timeout:1 attempts:1` into resolv.conf, and its DNS proxy can take
//! just over a second to answer a question it has not cached. musl, which the
//! agent is linked against, asks for A and AAAA together and fails the whole
//! lookup with "Try again" when either answer is late, however good the other.
//! A proxy that never caches the empty AAAA fails that way every single time,
//! while curl and nslookup on the same box work.
//!
//! So ask for IPv4 alone first, since the transit runs over IPv4 anyway, and
//! ask again after a timeout: by then the proxy has the answer in its cache.
//! Only a name with no A record at all goes through the ordinary lookup.

use std::ffi::{CStr, CString};
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use tokio::net::TcpStream;

const ATTEMPTS: u32 = 4;
const PAUSE: Duration = Duration::from_secs(1);

/// Every address of `host`, IPv4 only unless it has no IPv4 address.
pub async fn lookup(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    // A URI writes an IPv6 literal in brackets; getaddrinfo wants it without.
    let name = CString::new(host.trim_matches(['[', ']']))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in a host name"))?;
    let query = |family| {
        let name = name.clone();
        async move {
            tokio::task::spawn_blocking(move || getaddrinfo(&name, port, family))
                .await
                .unwrap_or(Err(libc::EAI_FAIL))
        }
    };
    lookup_with(query, PAUSE)
        .await
        .map_err(|code| io::Error::other(describe(code)))
}

/// Connect to the first address of `host` that takes the connection.
pub async fn connect(host: &str, port: u16) -> io::Result<TcpStream> {
    let mut last = None;
    for addr in lookup(host, port).await? {
        match TcpStream::connect(addr).await {
            Ok(stream) => return Ok(stream),
            Err(err) => last = Some(err),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other(format!("{host} has no address"))))
}

/// The same lookup for reqwest, which otherwise calls getaddrinfo its own way.
pub struct Resolver;

impl Resolve for Resolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addrs = lookup(name.as_str(), 0).await?;
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

async fn lookup_with<Q, F>(query: Q, pause: Duration) -> Result<Vec<SocketAddr>, i32>
where
    Q: Fn(i32) -> F,
    F: Future<Output = Result<Vec<SocketAddr>, i32>>,
{
    for attempt in 1..=ATTEMPTS {
        match query(libc::AF_INET).await {
            Ok(addrs) if !addrs.is_empty() => return Ok(addrs),
            Err(libc::EAI_AGAIN) if attempt == ATTEMPTS => return Err(libc::EAI_AGAIN),
            Err(libc::EAI_AGAIN) => tokio::time::sleep(pause).await,
            // No IPv4 address: the name may still have an IPv6 one.
            _ => break,
        }
    }
    query(libc::AF_UNSPEC).await
}

fn getaddrinfo(name: &CStr, port: u16, family: i32) -> Result<Vec<SocketAddr>, i32> {
    let mut hints: libc::addrinfo = unsafe { std::mem::zeroed() };
    hints.ai_family = family;
    hints.ai_socktype = libc::SOCK_STREAM;
    let mut list = std::ptr::null_mut();
    let code = unsafe { libc::getaddrinfo(name.as_ptr(), std::ptr::null(), &hints, &mut list) };
    if code != 0 {
        return Err(code);
    }

    let mut addrs = Vec::new();
    let mut entry = list;
    while !entry.is_null() {
        // SAFETY: getaddrinfo returned this list and it is freed only below;
        // ai_addr points at the sockaddr type that ai_family names.
        unsafe {
            let info = &*entry;
            match info.ai_family {
                libc::AF_INET => {
                    let sa = &*(info.ai_addr as *const libc::sockaddr_in);
                    let ip = Ipv4Addr::from(u32::from_be(sa.sin_addr.s_addr));
                    addrs.push(SocketAddr::from((ip, port)));
                }
                libc::AF_INET6 => {
                    let sa = &*(info.ai_addr as *const libc::sockaddr_in6);
                    let ip = Ipv6Addr::from(sa.sin6_addr.s6_addr);
                    addrs.push(SocketAddr::from((ip, port)));
                }
                _ => {}
            }
            entry = info.ai_next;
        }
    }
    unsafe { libc::freeaddrinfo(list) };
    Ok(addrs)
}

fn describe(code: i32) -> String {
    // SAFETY: gai_strerror returns a static string for any code.
    unsafe { CStr::from_ptr(libc::gai_strerror(code)) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn v4() -> Vec<SocketAddr> {
        vec![SocketAddr::from(([192, 0, 2, 1], 443))]
    }

    fn v6() -> Vec<SocketAddr> {
        vec![SocketAddr::from((Ipv6Addr::LOCALHOST, 443))]
    }

    /// Plays back the answers and records which families were asked for.
    async fn play(
        answers: Vec<Result<Vec<SocketAddr>, i32>>,
    ) -> (Result<Vec<SocketAddr>, i32>, Vec<i32>) {
        let answers = RefCell::new(answers.into_iter());
        let asked = RefCell::new(Vec::new());
        let result = lookup_with(
            |family| {
                asked.borrow_mut().push(family);
                let answer = answers.borrow_mut().next().expect("asked once too often");
                async move { answer }
            },
            Duration::ZERO,
        )
        .await;
        (result, asked.into_inner())
    }

    #[tokio::test]
    async fn the_first_answer_asks_nothing_else() {
        let (result, asked) = play(vec![Ok(v4())]).await;
        assert_eq!(result, Ok(v4()));
        assert_eq!(asked, [libc::AF_INET]);
    }

    #[tokio::test]
    async fn a_timeout_is_asked_again_and_never_widened_to_aaaa() {
        let again = Err(libc::EAI_AGAIN);
        let (result, asked) = play(vec![again.clone(), again, Ok(v4())]).await;
        assert_eq!(result, Ok(v4()));
        assert_eq!(asked, [libc::AF_INET; 3]);
    }

    #[tokio::test]
    async fn a_resolver_that_stays_down_is_reported() {
        let answers = vec![Err(libc::EAI_AGAIN); ATTEMPTS as usize];
        let (result, asked) = play(answers).await;
        assert_eq!(result, Err(libc::EAI_AGAIN));
        assert_eq!(asked.len(), ATTEMPTS as usize);
    }

    #[tokio::test]
    async fn a_name_without_ipv4_falls_back_to_the_ordinary_lookup() {
        let (result, asked) = play(vec![Err(libc::EAI_NONAME), Ok(v6())]).await;
        assert_eq!(result, Ok(v6()));
        assert_eq!(asked, [libc::AF_INET, libc::AF_UNSPEC]);
    }

    #[tokio::test]
    async fn literals_resolve_without_a_network() {
        let v4 = lookup("127.0.0.1", 443).await.unwrap();
        assert_eq!(v4, [SocketAddr::from(([127, 0, 0, 1], 443))]);
        let v6 = lookup("[::1]", 443).await.unwrap();
        assert_eq!(v6, [SocketAddr::from((Ipv6Addr::LOCALHOST, 443))]);
    }
}
