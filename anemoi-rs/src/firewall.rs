//! Letting the hub's clients out through this node.
//!
//! Clients arrive over the transit tunnel with addresses from the hub's pools
//! (the `nat-subnets` the panel sends) and leave through this machine's uplink
//! or into its LAN. That takes forwarding between the tunnel and the rest, and
//! masquerading the pools on the way out.
//!
//! Each platform has its own owner of the firewall, and the rules go where that
//! owner expects them — anything else is wiped at its next reload or fights it:
//! - OpenWrt: fw4, configured through uci (a zone, forwardings, a NAT rule);
//! - everything else: our own iptables chains, hooked in once. On Keenetic the
//!   firewall is rebuilt by NDMS, so a netfilter.d hook re-applies them.

use std::path::Path;
use std::process::Command;

use log::{info, warn};

use crate::Result;

pub trait Firewall: Send {
    /// Make the rules match `subnets` arriving on `dev`. Idempotent.
    fn apply(&mut self, subnets: &[String], dev: &str) -> Result<()>;
    /// Remove everything `apply` added.
    fn clear(&mut self) -> Result<()>;
    fn name(&self) -> &'static str;
}

pub fn detect() -> Box<dyn Firewall> {
    if Path::new("/etc/openwrt_release").exists() && Path::new("/sbin/fw4").exists() {
        Box::new(OpenWrt)
    } else {
        Box::new(Iptables)
    }
}

fn run(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|err| format!("{program}: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// --- OpenWrt -----------------------------------------------------------------

/// fw4 through uci. Named sections whose names start with `aeolus`, so we only
/// ever touch our own, and can find every one of them to remove later.
pub struct OpenWrt;

pub const UCI_PREFIX: &str = "aeolus";

impl OpenWrt {
    /// The uci commands that describe the wanted state.
    fn wanted(subnets: &[String], dev: &str) -> Vec<Vec<String>> {
        let s = |parts: &[&str]| parts.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let mut cmds = vec![
            // The tunnel is a zone of its own: nothing from it reaches the
            // router itself, and it only forwards where the rules below say.
            s(&["set", "firewall.aeolus=zone"]),
            s(&["set", "firewall.aeolus.name=aeolus"]),
            s(&["set", "firewall.aeolus.input=REJECT"]),
            s(&["set", "firewall.aeolus.output=ACCEPT"]),
            s(&["set", "firewall.aeolus.forward=REJECT"]),
            s(&["delete", "firewall.aeolus.device"]),
            vec!["add_list".into(), format!("firewall.aeolus.device={dev}")],
            // Out to the internet: the wan zone already masquerades.
            s(&["set", "firewall.aeolus_wan=forwarding"]),
            s(&["set", "firewall.aeolus_wan.src=aeolus"]),
            s(&["set", "firewall.aeolus_wan.dest=wan"]),
            // Into the LAN, for clients granted it. The LAN's hosts route the
            // pools nowhere, so masquerade there too.
            s(&["set", "firewall.aeolus_lan=forwarding"]),
            s(&["set", "firewall.aeolus_lan.src=aeolus"]),
            s(&["set", "firewall.aeolus_lan.dest=lan"]),
        ];
        // One NAT section per subnet: fw4 takes a single src_ip there, and
        // skips the whole section if given a list.
        for (i, subnet) in subnets.iter().enumerate() {
            let section = format!("firewall.aeolus_masq_lan{i}");
            cmds.push(vec!["set".into(), format!("{section}=nat")]);
            cmds.push(vec![
                "set".into(),
                format!("{section}.name=aeolus-masq-lan-{i}"),
            ]);
            cmds.push(vec!["set".into(), format!("{section}.src=lan")]);
            cmds.push(vec!["set".into(), format!("{section}.src_ip={subnet}")]);
            cmds.push(vec!["set".into(), format!("{section}.target=MASQUERADE")]);
            cmds.push(vec!["set".into(), format!("{section}.proto=all")]);
        }
        cmds
    }

    /// Names of our sections as uci currently sees them, staged edits included.
    fn ours() -> Vec<String> {
        let shown = run("uci", &["-q", "show", "firewall"]).unwrap_or_default();
        let mut names: Vec<String> = shown
            .lines()
            .filter_map(|line| line.strip_prefix("firewall."))
            .filter_map(|rest| rest.split(['.', '=']).next())
            .filter(|name| name.starts_with(UCI_PREFIX))
            .map(String::from)
            .collect();
        names.sort();
        names.dedup();
        names
    }

    fn current() -> String {
        Self::ours()
            .iter()
            .map(|section| {
                run("uci", &["-q", "show", &format!("firewall.{section}")]).unwrap_or_default()
            })
            .collect()
    }

    fn reload() -> Result<()> {
        run("uci", &["commit", "firewall"])?;
        run("/etc/init.d/firewall", &["reload"])?;
        Ok(())
    }
}

impl Firewall for OpenWrt {
    fn apply(&mut self, subnets: &[String], dev: &str) -> Result<()> {
        let before = Self::current();
        let mut touched = Self::ours();
        // NAT sections are rebuilt from the list each time, so a subnet the
        // panel dropped leaves no stale rule behind.
        for section in touched.iter().filter(|s| s.starts_with("aeolus_masq")) {
            let _ = run("uci", &["-q", "delete", &format!("firewall.{section}")]);
        }
        for cmd in Self::wanted(subnets, dev) {
            let args: Vec<&str> = cmd.iter().map(String::as_str).collect();
            // `delete` of something absent fails; that is the state we want.
            if args[0] == "delete" {
                let _ = run("uci", &["-q", args[0], args[1]]);
            } else {
                run("uci", &args)?;
            }
        }
        if Self::current() != before
            || !succeeds(
                "sh",
                &[
                    "-c",
                    "nft list chain inet fw4 forward_aeolus >/dev/null 2>&1",
                ],
            )
        {
            Self::reload()?;
            info!(
                "firewall: fw4 zone aeolus on {dev}, masquerading {}",
                subnets.join(", ")
            );
        } else {
            // Nothing changed: drop our staged no-op edits, and only ours —
            // someone may have uncommitted changes of their own in there.
            touched.extend(Self::ours());
            touched.sort();
            touched.dedup();
            for section in touched {
                let _ = run("uci", &["revert", &format!("firewall.{section}")]);
            }
        }
        Ok(())
    }

    fn clear(&mut self) -> Result<()> {
        let mut removed = false;
        for section in Self::ours() {
            if succeeds("uci", &["-q", "delete", &format!("firewall.{section}")]) {
                removed = true;
            }
        }
        if removed {
            Self::reload()?;
            // A reload flushes rules but keeps chains: the zone's would stay
            // behind, empty and unreferenced. Take them away too.
            let table = run("nft", &["list", "table", "inet", "fw4"]).unwrap_or_default();
            for chain in table
                .lines()
                .filter_map(|line| line.trim().strip_prefix("chain "))
                .map(|rest| rest.trim_end_matches('{').trim())
                .filter(|name| name.contains(UCI_PREFIX))
            {
                let _ = run("nft", &["delete", "chain", "inet", "fw4", chain]);
            }
        }
        Ok(())
    }

    fn name(&self) -> &'static str {
        "fw4 (uci)"
    }
}

// --- iptables ---------------------------------------------------------------

/// Our own chains, hooked into FORWARD and POSTROUTING once. Flushing them can
/// never disturb anything else on the box.
pub struct Iptables;

const CHAIN: &str = "AEOLUS-NODE";

/// Priority of our "to <pool> lookup main" rules. Below 100, where Keenetic's
/// connection policies start: NDMS marks a LAN host that sits in a policy
/// other than the default one by MAC, routes its traffic through that
/// policy's table and blackholes whatever the table has no route for. The
/// table knows nothing of the tunnel, so a granted client's packets reach
/// such a host and its replies vanish. xkeen uses 99 for its own mark, and
/// the pools never carry it (private destinations are not proxied).
const RULE_PREF: &str = "90";

/// The pools our rules currently cover, from `ip -4 rule show` output.
fn parse_pool_rules(shown: &str) -> Vec<String> {
    let mut pools: Vec<String> = shown
        .lines()
        .filter_map(|line| line.trim().strip_prefix(&format!("{RULE_PREF}:")))
        .filter(|rest| {
            rest.split_whitespace()
                .collect::<Vec<_>>()
                .ends_with(&["lookup", "main"])
        })
        .filter_map(|rest| {
            let mut words = rest.split_whitespace();
            words.find(|w| *w == "to")?;
            words.next().map(normalise_cidr)
        })
        .collect();
    pools.sort();
    pools.dedup();
    pools
}

/// `ip rule` prints a host route without its "/32".
fn normalise_cidr(cidr: &str) -> String {
    if cidr.contains('/') {
        cidr.to_string()
    } else {
        format!("{cidr}/32")
    }
}

fn pool_rules() -> Vec<String> {
    parse_pool_rules(&run("ip", &["-4", "rule", "show"]).unwrap_or_default())
}

fn pool_rule(op: &str, pool: &str) -> Result<()> {
    run(
        "ip",
        &[
            "-4", "rule", op, "to", pool, "lookup", "main", "pref", RULE_PREF,
        ],
    )
    .map(|_| ())
}

/// Replies to the pools take the main table, where the tunnel's routes are,
/// whatever policy routing the box does for its LAN hosts.
fn ensure_pool_rules(subnets: &[String]) -> Result<()> {
    let wanted: Vec<String> = subnets.iter().map(|s| normalise_cidr(s)).collect();
    let present = pool_rules();
    for pool in present.iter().filter(|p| !wanted.contains(p)) {
        pool_rule("del", pool)?;
    }
    for pool in wanted.iter().filter(|p| !present.contains(p)) {
        pool_rule("add", pool)?;
        info!("routing: replies to {pool} take the main table (rule pref {RULE_PREF})");
    }
    Ok(())
}

impl Iptables {
    fn hook(table: &str, parent: &str) -> Result<()> {
        let _ = run("iptables", &["-t", table, "-N", CHAIN]);
        run("iptables", &["-t", table, "-F", CHAIN])?;
        if !succeeds("iptables", &["-t", table, "-C", parent, "-j", CHAIN]) {
            run("iptables", &["-t", table, "-I", parent, "1", "-j", CHAIN])?;
        }
        Ok(())
    }

    fn unhook(table: &str, parent: &str) {
        while succeeds("iptables", &["-t", table, "-D", parent, "-j", CHAIN]) {}
        let _ = run("iptables", &["-t", table, "-F", CHAIN]);
        let _ = run("iptables", &["-t", table, "-X", CHAIN]);
    }
}

impl Firewall for Iptables {
    fn apply(&mut self, subnets: &[String], dev: &str) -> Result<()> {
        Self::hook("filter", "FORWARD")?;
        Self::hook("nat", "POSTROUTING")?;
        for subnet in subnets {
            let s = subnet.as_str();
            run(
                "iptables",
                &["-A", CHAIN, "-i", dev, "-s", s, "-j", "ACCEPT"],
            )?;
            run(
                "iptables",
                &[
                    "-A",
                    CHAIN,
                    "-o",
                    dev,
                    "-d",
                    s,
                    "-m",
                    "conntrack",
                    "--ctstate",
                    "ESTABLISHED,RELATED",
                    "-j",
                    "ACCEPT",
                ],
            )?;
            // Out of anything but the tunnel itself: uplink or LAN.
            run(
                "iptables",
                &[
                    "-t",
                    "nat",
                    "-A",
                    CHAIN,
                    "-s",
                    s,
                    "!",
                    "-o",
                    dev,
                    "-j",
                    "MASQUERADE",
                ],
            )?;
        }
        ensure_pool_rules(subnets)
    }

    fn clear(&mut self) -> Result<()> {
        Self::unhook("filter", "FORWARD");
        Self::unhook("nat", "POSTROUTING");
        for pool in pool_rules() {
            let _ = pool_rule("del", &pool);
        }
        Ok(())
    }

    fn name(&self) -> &'static str {
        "iptables"
    }
}

/// Forwarding must be on for any of this to matter. Turned on at runtime; the
/// installer makes it persistent where the platform keeps such settings.
pub fn ensure_forwarding() {
    let path = "/proc/sys/net/ipv4/ip_forward";
    if std::fs::read_to_string(path)
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
    {
        return;
    }
    if let Err(err) = std::fs::write(path, "1") {
        warn!("cannot enable IPv4 forwarding: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_rules_are_read_back_from_ip_rule_show() {
        // Keenetic 5.1 with xkeen and a connection policy, after our rules.
        let shown = "0:\tfrom all lookup local \n\
                     90:\tfrom all to 10.20.0.0/24 lookup main \n\
                     90:\tfrom all to 10.21.0.0/24 lookup main \n\
                     90:\tfrom all to 10.30.0.5 lookup main \n\
                     90:\tfrom 10.9.0.0/24 lookup 7 \n\
                     99:\tfrom all fwmark 0x111 lookup 111 \n\
                     100:\tfrom all fwmark 0xffffaaa lookup 4096 \n\
                     190:\tfrom all to 10.40.0.0/24 lookup main \n\
                     32766:\tfrom all lookup main \n";
        assert_eq!(
            parse_pool_rules(shown),
            vec!["10.20.0.0/24", "10.21.0.0/24", "10.30.0.5/32"]
        );
        assert!(parse_pool_rules("").is_empty());
    }

    #[test]
    fn openwrt_rules_name_only_our_sections() {
        let cmds = OpenWrt::wanted(&["10.20.0.0/24".into(), "10.21.0.0/24".into()], "aeolus0");
        for cmd in &cmds {
            let target = cmd[1].trim_start_matches("firewall.");
            assert!(
                target.starts_with(UCI_PREFIX),
                "touches foreign section {target}"
            );
            // fw4 skips a NAT section whose src_ip is a list.
            if target.starts_with("aeolus_masq") {
                assert_ne!(cmd[0], "add_list", "{target}: no lists in NAT sections");
            }
        }
        assert!(
            cmds.iter()
                .any(|c| c[1] == "firewall.aeolus_masq_lan0.src_ip=10.20.0.0/24")
        );
        assert!(
            cmds.iter()
                .any(|c| c[1] == "firewall.aeolus_masq_lan1.src_ip=10.21.0.0/24")
        );
        assert!(
            cmds.iter()
                .any(|c| c[1] == "firewall.aeolus.device=aeolus0")
        );
    }
}
