//! Letting the hub's clients out through this node, and linked sites in.
//!
//! Clients arrive over the transit tunnel with addresses from the hub's pools
//! (the `nat-subnets` the panel sends) and leave through this machine's uplink
//! or into its LAN. That takes forwarding between the tunnel and the rest, and
//! masquerading the pools on the way out.
//!
//! The node's own address in its LAN is part of that LAN: a client granted the
//! LAN reaches the router there too (its web UI, DNS, ping). Only that address —
//! the transit address, the uplink and anything else on the box stay closed.
//! The hub already decides which client may reach the LAN at all.
//!
//! Sites linked to this one (the `site-subnets`) are networks behind the hub or
//! behind another node. They are forwarded both ways between the LAN and the
//! tunnel and never masqueraded: this machine is its LAN's gateway, so the
//! addresses on either side are ones the other side can answer.
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

/// What the panel last asked for, as the files the agent wrote from it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    /// The hub's client pools: forwarded in from the tunnel, masqueraded out.
    pub pools: Vec<String>,
    /// Networks of the linked sites: forwarded both ways, never masqueraded.
    pub sites: Vec<String>,
    /// This node's own LANs (ANEMOI_SUBNETS): the pools may reach the node's
    /// addresses in them.
    pub lans: Vec<String>,
}

impl Plan {
    pub fn read(config_dir: &Path, lans: &[String]) -> Plan {
        let list = |name: &str| -> Vec<String> {
            std::fs::read_to_string(config_dir.join(name))
                .unwrap_or_default()
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect()
        };
        Plan {
            pools: list("nat-subnets"),
            sites: list("site-subnets"),
            lans: lans.to_vec(),
        }
    }

    /// "Nothing from the panel yet". The LANs come from local settings, so
    /// they alone do not make a plan.
    pub fn is_empty(&self) -> bool {
        self.pools.is_empty() && self.sites.is_empty()
    }

    /// Everything reached through the tunnel.
    fn tunnel_networks(&self) -> Vec<String> {
        self.pools.iter().chain(&self.sites).cloned().collect()
    }

    /// (pool, LAN) pairs: who may reach the node's own LAN address.
    fn lan_access(&self) -> Vec<(&str, &str)> {
        self.pools
            .iter()
            .flat_map(|pool| {
                self.lans
                    .iter()
                    .map(move |lan| (pool.as_str(), lan.as_str()))
            })
            .collect()
    }
}

pub trait Firewall: Send {
    /// Make the rules match `plan` for traffic on `dev`. Idempotent.
    fn apply(&mut self, plan: &Plan, dev: &str) -> Result<()>;
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
    fn wanted(plan: &Plan, dev: &str) -> Vec<Vec<String>> {
        let s = |parts: &[&str]| parts.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let mut cmds = vec![
            // The tunnel is a zone of its own: from it the router answers only
            // on its LAN address (the aeolus_in rules), and it only forwards
            // where the rules below say.
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
        // From the LAN into the tunnel: only toward linked sites, which the
        // routes pushed by the hub already limit to. Without links the LAN
        // has no business in the tunnel at all.
        if plan.sites.is_empty() {
            cmds.push(s(&["delete", "firewall.aeolus_lan_out"]));
        } else {
            cmds.push(s(&["set", "firewall.aeolus_lan_out=forwarding"]));
            cmds.push(s(&["set", "firewall.aeolus_lan_out.src=lan"]));
            cmds.push(s(&["set", "firewall.aeolus_lan_out.dest=aeolus"]));
        }
        // The router's own LAN address, for the pools. Without a dest, a
        // rule is an input rule; with dest_ip in the LAN it matches only the
        // router's address there, so the zone's input=REJECT keeps the rest.
        // One section per pair, single values, like the NAT ones below.
        for (i, (pool, lan)) in plan.lan_access().into_iter().enumerate() {
            let section = format!("firewall.aeolus_in{i}");
            cmds.push(vec!["set".into(), format!("{section}=rule")]);
            cmds.push(vec!["set".into(), format!("{section}.name=aeolus-in-{i}")]);
            cmds.push(vec!["set".into(), format!("{section}.src=aeolus")]);
            cmds.push(vec!["set".into(), format!("{section}.src_ip={pool}")]);
            cmds.push(vec!["set".into(), format!("{section}.dest_ip={lan}")]);
            cmds.push(vec!["set".into(), format!("{section}.proto=all")]);
            cmds.push(vec!["set".into(), format!("{section}.target=ACCEPT")]);
        }
        // One NAT section per subnet: fw4 takes a single src_ip there, and
        // skips the whole section if given a list.
        for (i, subnet) in plan.pools.iter().enumerate() {
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
    fn apply(&mut self, plan: &Plan, dev: &str) -> Result<()> {
        let before = Self::current();
        let mut touched = Self::ours();
        // NAT and input sections are rebuilt from the lists each time, so a
        // subnet the panel dropped leaves no stale rule behind.
        for section in touched
            .iter()
            .filter(|s| s.starts_with("aeolus_masq") || s.starts_with("aeolus_in"))
        {
            let _ = run("uci", &["-q", "delete", &format!("firewall.{section}")]);
        }
        for cmd in Self::wanted(plan, dev) {
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
                "firewall: fw4 zone aeolus on {dev}, masquerading {}; linked sites {}",
                plan.pools.join(", "),
                if plan.sites.is_empty() {
                    "none".to_string()
                } else {
                    plan.sites.join(", ")
                }
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
/// Ours in filter INPUT: the pools to the node's own LAN address. A chain of
/// its own, because the forwarding rules in CHAIN would open the whole box.
const INPUT_CHAIN: &str = "AEOLUS-NODE-IN";

/// iptables arguments for the INPUT chain. In INPUT a destination in the LAN
/// can only be one of the node's own addresses there.
fn input_rules(plan: &Plan, dev: &str) -> Vec<Vec<String>> {
    plan.lan_access()
        .into_iter()
        .map(|(pool, lan)| {
            [
                "-A",
                INPUT_CHAIN,
                "-i",
                dev,
                "-s",
                pool,
                "-d",
                lan,
                "-j",
                "ACCEPT",
            ]
            .iter()
            .map(|a| a.to_string())
            .collect()
        })
        .collect()
}

/// Priority of our "to <network> lookup main" rules, one per network reached
/// through the tunnel (client pools and linked sites). Below 100, where Keenetic's
/// connection policies start: NDMS marks a LAN host that sits in a policy
/// other than the default one by MAC, routes its traffic through that
/// policy's table and blackholes whatever the table has no route for. The
/// table knows nothing of the tunnel, so a granted client's packets reach
/// such a host and its replies vanish. xkeen uses 99 for its own mark, and
/// the pools never carry it (private destinations are not proxied).
const RULE_PREF: &str = "90";

/// The networks our rules currently cover, from `ip -4 rule show` output.
fn parse_tunnel_rules(shown: &str) -> Vec<String> {
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

fn tunnel_rules() -> Vec<String> {
    parse_tunnel_rules(&run("ip", &["-4", "rule", "show"]).unwrap_or_default())
}

fn tunnel_rule(op: &str, pool: &str) -> Result<()> {
    run(
        "ip",
        &[
            "-4", "rule", op, "to", pool, "lookup", "main", "pref", RULE_PREF,
        ],
    )
    .map(|_| ())
}

/// Traffic to anything behind the tunnel takes the main table, where the
/// tunnel's routes are, whatever policy routing the box does for its LAN hosts:
/// replies to the pools, and a LAN host's own connections to a linked site.
fn ensure_tunnel_rules(networks: &[String]) -> Result<()> {
    let wanted: Vec<String> = networks.iter().map(|s| normalise_cidr(s)).collect();
    let present = tunnel_rules();
    for net in present.iter().filter(|p| !wanted.contains(p)) {
        tunnel_rule("del", net)?;
    }
    for net in wanted.iter().filter(|p| !present.contains(p)) {
        tunnel_rule("add", net)?;
        info!("routing: traffic to {net} takes the main table (rule pref {RULE_PREF})");
    }
    Ok(())
}

impl Iptables {
    fn hook(table: &str, parent: &str, chain: &str) -> Result<()> {
        let _ = run("iptables", &["-t", table, "-N", chain]);
        run("iptables", &["-t", table, "-F", chain])?;
        if !succeeds("iptables", &["-t", table, "-C", parent, "-j", chain]) {
            run("iptables", &["-t", table, "-I", parent, "1", "-j", chain])?;
        }
        Ok(())
    }

    fn unhook(table: &str, parent: &str, chain: &str) {
        while succeeds("iptables", &["-t", table, "-D", parent, "-j", chain]) {}
        let _ = run("iptables", &["-t", table, "-F", chain]);
        let _ = run("iptables", &["-t", table, "-X", chain]);
    }
}

impl Firewall for Iptables {
    fn apply(&mut self, plan: &Plan, dev: &str) -> Result<()> {
        Self::hook("filter", "FORWARD", CHAIN)?;
        Self::hook("nat", "POSTROUTING", CHAIN)?;
        Self::hook("filter", "INPUT", INPUT_CHAIN)?;
        for rule in input_rules(plan, dev) {
            let args: Vec<&str> = rule.iter().map(String::as_str).collect();
            run("iptables", &args)?;
        }
        for subnet in &plan.pools {
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
        // Linked sites, both ways. The hub decides which direction may start a
        // flow (into its own LAN only outward, masqueraded there); here both
        // are open, because a node-to-node link starts from either end.
        for site in &plan.sites {
            let s = site.as_str();
            run(
                "iptables",
                &["-A", CHAIN, "-o", dev, "-d", s, "-j", "ACCEPT"],
            )?;
            run(
                "iptables",
                &["-A", CHAIN, "-i", dev, "-s", s, "-j", "ACCEPT"],
            )?;
            // Leave the LAN's addresses alone on the way into the tunnel. NDMS
            // masquerades its home segment out of every interface but its own
            // bridge (`_NDM_MASQ: -s <LAN> ! -o br0`), which would hand the
            // other site the node's transit address instead: the hub would
            // not recognise the flow as the link's, and a node-to-node link
            // could never be answered. Our chain runs first in POSTROUTING, so
            // an ACCEPT here ends NAT for these packets before NDMS sees them.
            run(
                "iptables",
                &["-t", "nat", "-A", CHAIN, "-o", dev, "-d", s, "-j", "ACCEPT"],
            )?;
        }
        ensure_tunnel_rules(&plan.tunnel_networks())
    }

    fn clear(&mut self) -> Result<()> {
        Self::unhook("filter", "FORWARD", CHAIN);
        Self::unhook("nat", "POSTROUTING", CHAIN);
        Self::unhook("filter", "INPUT", INPUT_CHAIN);
        for net in tunnel_rules() {
            let _ = tunnel_rule("del", &net);
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
    fn tunnel_rules_are_read_back_from_ip_rule_show() {
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
            parse_tunnel_rules(shown),
            vec!["10.20.0.0/24", "10.21.0.0/24", "10.30.0.5/32"]
        );
        assert!(parse_tunnel_rules("").is_empty());
    }

    #[test]
    fn openwrt_rules_name_only_our_sections() {
        let plan = Plan {
            pools: vec!["10.20.0.0/24".into(), "10.21.0.0/24".into()],
            sites: vec![],
            lans: vec![],
        };
        let cmds = OpenWrt::wanted(&plan, "aeolus0");
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

    #[test]
    fn openwrt_lets_the_lan_into_the_tunnel_only_with_links() {
        let has = |cmds: &[Vec<String>], op: &str, what: &str| {
            cmds.iter().any(|c| c[0] == op && c[1] == what)
        };
        let unlinked = Plan {
            pools: vec!["10.20.0.0/24".into()],
            sites: vec![],
            lans: vec![],
        };
        let cmds = OpenWrt::wanted(&unlinked, "aeolus0");
        assert!(has(&cmds, "delete", "firewall.aeolus_lan_out"));
        assert!(!has(&cmds, "set", "firewall.aeolus_lan_out=forwarding"));

        let linked = Plan {
            pools: vec!["10.20.0.0/24".into()],
            sites: vec!["192.168.1.0/24".into()],
            lans: vec![],
        };
        let cmds = OpenWrt::wanted(&linked, "aeolus0");
        assert!(has(&cmds, "set", "firewall.aeolus_lan_out=forwarding"));
        assert!(has(&cmds, "set", "firewall.aeolus_lan_out.dest=aeolus"));
        // Sites are never masqueraded: only the pools get NAT sections.
        assert!(!cmds.iter().any(|c| c[1].contains("src_ip=192.168.1.0/24")));
    }

    #[test]
    fn plan_reads_both_lists_and_covers_both_with_rules() {
        let dir = std::env::temp_dir().join(format!("anemoi-plan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("nat-subnets"), "10.20.0.0/24\n\n10.21.0.0/24\n").unwrap();
        std::fs::write(dir.join("site-subnets"), " 192.168.1.0/24 \n").unwrap();
        let plan = Plan::read(&dir, &["192.168.3.0/24".to_string()]);
        assert_eq!(plan.lans, vec!["192.168.3.0/24"]);
        assert_eq!(plan.pools, vec!["10.20.0.0/24", "10.21.0.0/24"]);
        assert_eq!(plan.sites, vec!["192.168.1.0/24"]);
        assert_eq!(
            plan.tunnel_networks(),
            vec!["10.20.0.0/24", "10.21.0.0/24", "192.168.1.0/24"]
        );
        assert!(!plan.is_empty());
        // An agent from before links writes no site-subnets: still a valid plan.
        std::fs::remove_file(dir.join("site-subnets")).unwrap();
        assert!(Plan::read(&dir, &[]).sites.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(Plan::read(&dir, &[]).is_empty());
        // Local LANs without anything from the panel are still no plan.
        assert!(Plan::read(&dir, &["192.168.3.0/24".to_string()]).is_empty());
    }

    fn lan_plan() -> Plan {
        Plan {
            pools: vec!["10.20.0.0/24".into(), "10.21.0.0/24".into()],
            sites: vec!["192.168.1.0/24".into()],
            lans: vec!["192.168.3.0/24".into()],
        }
    }

    #[test]
    fn iptables_opens_only_the_lan_address_to_the_pools() {
        let rules = input_rules(&lan_plan(), "aeolus0");
        let joined: Vec<String> = rules.iter().map(|r| r.join(" ")).collect();
        assert_eq!(
            joined,
            vec![
                "-A AEOLUS-NODE-IN -i aeolus0 -s 10.20.0.0/24 -d 192.168.3.0/24 -j ACCEPT",
                "-A AEOLUS-NODE-IN -i aeolus0 -s 10.21.0.0/24 -d 192.168.3.0/24 -j ACCEPT",
            ]
        );
        // Linked sites get no way into the box, and no LAN means no rule.
        assert!(!joined.iter().any(|r| r.contains("192.168.1.0/24")));
        let mut no_lan = lan_plan();
        no_lan.lans.clear();
        assert!(input_rules(&no_lan, "aeolus0").is_empty());
    }

    #[test]
    fn openwrt_input_rules_name_one_pool_and_one_lan() {
        let cmds = OpenWrt::wanted(&lan_plan(), "aeolus0");
        let has = |what: &str| cmds.iter().any(|c| c[0] == "set" && c[1] == what);
        assert!(has("firewall.aeolus_in0=rule"));
        assert!(has("firewall.aeolus_in0.src=aeolus"));
        assert!(has("firewall.aeolus_in0.src_ip=10.20.0.0/24"));
        assert!(has("firewall.aeolus_in0.dest_ip=192.168.3.0/24"));
        assert!(has("firewall.aeolus_in0.target=ACCEPT"));
        assert!(has("firewall.aeolus_in1.src_ip=10.21.0.0/24"));
        // An input rule has no dest zone, and the zone itself stays closed.
        assert!(
            !cmds
                .iter()
                .any(|c| c[1].starts_with("firewall.aeolus_in0.dest="))
        );
        assert!(has("firewall.aeolus.input=REJECT"));
        assert!(
            !cmds
                .iter()
                .any(|c| c[0] == "add_list" && c[1].starts_with("firewall.aeolus_in"))
        );
    }
}
