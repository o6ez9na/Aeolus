//! The transit tunnel inside a WebSocket, on the panel's own HTTPS port.
//!
//! Some networks pass an OpenVPN handshake and then kill the flow whatever
//! port it uses; inside a real TLS session on 443 there is nothing left to
//! recognise. In docker a wstunnel container does this next to OpenVPN. On a
//! router the agent does it itself: a listener on localhost that OpenVPN
//! dials, and for each connection a WebSocket to the panel.
//!
//! The panel side is an unmodified wstunnel server (v10) behind Caddy, so this
//! speaks its protocol: `GET /<prefix>/events` upgraded to a WebSocket, the
//! destination in a JWT carried in `Sec-WebSocket-Protocol`, then raw TCP bytes
//! in binary frames. wstunnel does not check the JWT signature — the
//! destination is pinned server-side with `--restrict-to` — so the key here is
//! random and only keeps the token well-formed.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use ring::rand::{SecureRandom, SystemRandom};
use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use crate::Result;

#[derive(Clone)]
pub struct Bridge {
    /// The panel's public name: TLS SNI, certificate check and Host header.
    pub panel_host: String,
    pub panel_port: u16,
    /// wstunnel's `--http-upgrade-path-prefix` on the panel.
    pub path_prefix: String,
    /// Where wstunnel on the panel connects to: the hub's transit listener.
    pub target_host: String,
    pub target_port: u16,
    pub tls: Arc<rustls::ClientConfig>,
}

const PING_EVERY: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

impl Bridge {
    /// Accept OpenVPN's connections on `listener` and carry each to the panel.
    pub async fn serve(self, listener: TcpListener) {
        let bridge = Arc::new(self);
        loop {
            let (socket, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(err) => {
                    warn!("transit bridge: accept failed: {err}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            let bridge = bridge.clone();
            tokio::spawn(async move {
                debug!("transit bridge: connection from {peer}");
                match bridge.relay(socket).await {
                    Ok(()) => debug!("transit bridge: {peer} closed"),
                    Err(err) => warn!("transit bridge: {err}"),
                }
            });
        }
    }

    async fn relay(&self, local: TcpStream) -> Result<()> {
        let remote = tokio::time::timeout(
            CONNECT_TIMEOUT,
            crate::resolve::connect(&self.panel_host, self.panel_port),
        )
        .await
        .map_err(|_| {
            format!(
                "timed out connecting to {}:{}",
                self.panel_host, self.panel_port
            )
        })??;
        remote.set_nodelay(true)?;
        local.set_nodelay(true)?;

        let name = ServerName::try_from(self.panel_host.clone())?;
        let mut tls = TlsConnector::from(self.tls.clone())
            .connect(name, remote)
            .await?;

        self.upgrade(&mut tls).await?;
        // wstunnel neither masks its client frames nor unmasks what it reads
        // (`--websocket-mask-frame` is off by default), so a client that masks,
        // as RFC 6455 asks, delivers scrambled bytes to OpenVPN. Speak the way
        // wstunnel's own client does: tungstenite's server role writes unmasked
        // frames, and is told to accept the unmasked frames the panel sends.
        let config = WebSocketConfig::default().accept_unmasked_frames(true);
        let socket = WebSocketStream::from_raw_socket(tls, Role::Server, Some(config)).await;
        info!(
            "transit bridge: tunnel to {}:{} open",
            self.target_host, self.target_port
        );

        let (mut ws_tx, mut ws_rx) = socket.split();
        let (mut tcp_rx, mut tcp_tx) = local.into_split();

        let upstream = async {
            let mut buf = vec![0u8; 32 * 1024];
            let mut ping = tokio::time::interval(PING_EVERY);
            ping.tick().await;
            loop {
                tokio::select! {
                    read = tcp_rx.read(&mut buf) => {
                        let n = read?;
                        if n == 0 {
                            let _ = ws_tx.send(Message::Close(None)).await;
                            return Ok::<(), crate::BoxError>(());
                        }
                        ws_tx.send(Message::binary(buf[..n].to_vec())).await?;
                    }
                    // Keeps proxies on the way from closing a quiet tunnel.
                    _ = ping.tick() => ws_tx.send(Message::Ping(Vec::new().into())).await?,
                }
            }
        };
        let downstream = async {
            while let Some(message) = ws_rx.next().await {
                match message? {
                    Message::Binary(data) => tcp_tx.write_all(&data).await?,
                    Message::Close(_) => break,
                    // Pings are answered by tungstenite itself.
                    _ => {}
                }
            }
            Ok::<(), crate::BoxError>(())
        };
        // Whichever side ends first ends the tunnel; OpenVPN reconnects.
        tokio::select! {
            result = upstream => result,
            result = downstream => result,
        }
    }

    /// The HTTP/1.1 upgrade, by hand: tungstenite's client handshake would
    /// also make it mask every frame afterwards (see `relay`).
    async fn upgrade<S: AsyncRead + AsyncWrite + Unpin>(&self, stream: &mut S) -> Result<()> {
        let mut nonce = [0u8; 16];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "no randomness")?;
        let key = STANDARD.encode(nonce);
        let request = format!(
            "GET /{prefix}/events HTTP/1.1\r\n\
             Host: {host}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: {key}\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Protocol: v1, authorization.bearer.{token}\r\n\
             \r\n",
            prefix = self.path_prefix,
            host = self.panel_host,
            token = self.token()?,
        );
        stream.write_all(request.as_bytes()).await?;
        stream.flush().await?;

        // Byte by byte up to the blank line: the server may follow its headers
        // with frames, and those must stay in the stream for tungstenite.
        let mut head = Vec::with_capacity(512);
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() > 16 * 1024 {
                return Err("WebSocket upgrade: response headers too long".into());
            }
            head.push(stream.read_u8().await?);
        }
        let head = String::from_utf8_lossy(&head);
        let mut lines = head.lines();
        let status = lines.next().unwrap_or_default();
        if status.split_whitespace().nth(1) != Some("101") {
            return Err(
                format!("WebSocket upgrade at {} refused: {status}", self.panel_host).into(),
            );
        }
        let accept = lines
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.trim().eq_ignore_ascii_case("sec-websocket-accept"))
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default();
        if accept != accept_key(&key) {
            return Err("WebSocket upgrade: bad Sec-WebSocket-Accept".into());
        }
        Ok(())
    }

    /// The JWT wstunnel reads the destination from.
    fn token(&self) -> Result<String> {
        let rng = SystemRandom::new();
        let mut id = [0u8; 16];
        rng.fill(&mut id).map_err(|_| "no randomness")?;
        // UUID v4 layout, as wstunnel generates it.
        id[6] = (id[6] & 0x0f) | 0x40;
        id[8] = (id[8] & 0x3f) | 0x80;
        let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
        let uuid = format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        );

        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"HS256"}"#);
        let claims = serde_json::json!({
            "id": uuid,
            "p": {"Tcp": {"proxy_protocol": false}},
            "r": self.target_host,
            "rp": self.target_port,
        });
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);

        let mut secret = [0u8; 32];
        rng.fill(&mut secret).map_err(|_| "no randomness")?;
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &secret);
        let signature = ring::hmac::sign(&key, format!("{header}.{claims}").as_bytes());
        Ok(format!(
            "{header}.{claims}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
}

/// RFC 6455: base64(SHA-1(key + GUID)).
fn accept_key(key: &str) -> String {
    let digest = ring::digest::digest(
        &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes(),
    );
    STANDARD.encode(digest.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> Bridge {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
        Bridge {
            panel_host: "panel.example.com".into(),
            panel_port: 443,
            path_prefix: "transit".into(),
            target_host: "openvpn".into(),
            target_port: 1195,
            tls: Arc::new(tls),
        }
    }

    #[test]
    fn accept_key_matches_rfc_example() {
        assert_eq!(
            accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn token_carries_the_destination_wstunnel_expects() {
        let token = bridge().token().unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["r"], "openvpn");
        assert_eq!(claims["rp"], 1195);
        assert_eq!(claims["p"]["Tcp"]["proxy_protocol"], false);
        let id = claims["id"].as_str().unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "HS256");
    }
}
