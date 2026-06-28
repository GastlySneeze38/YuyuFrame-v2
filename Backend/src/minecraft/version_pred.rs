use std::cmp::Ordering;

/// Composants numériques en tête de version ("0.8.13-beta.1+mc1.21.11" → [0, 8, 13]).
/// Le suffixe pré-release/build est ignoré pour la comparaison : il suffit pour
/// exclure une version d'une plage qui se termine juste avant son cœur numérique.
pub fn version_core(v: &str) -> Vec<u64> {
    v.split(['.', '-', '+'])
        .take_while(|p| p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty())
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

pub fn cmp_core(a: &[u64], b: &[u64]) -> Ordering {
    let len = a.len().max(b.len());
    for i in 0..len {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

fn is_wildcard_component(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "x" | "*" | "")
}

/// Un seul jeton de contrainte (">=0.8.4", "0.8.12", "0.8.x", "*"...).
pub fn token_satisfied(core: &[u64], token: &str) -> bool {
    let token = token.trim();
    if token.is_empty() || token == "*" {
        return true;
    }
    for op in [">=", "<=", ">", "<", "^", "~", "="] {
        if let Some(rest) = token.strip_prefix(op) {
            let target = version_core(rest);
            return match op {
                ">=" => cmp_core(core, &target) != Ordering::Less,
                "<=" => cmp_core(core, &target) != Ordering::Greater,
                ">" => cmp_core(core, &target) == Ordering::Greater,
                "<" => cmp_core(core, &target) == Ordering::Less,
                "^" => core.first() == target.first() && cmp_core(core, &target) != Ordering::Less,
                "~" => {
                    core.first() == target.first()
                        && core.get(1) == target.get(1)
                        && cmp_core(core, &target) != Ordering::Less
                }
                "=" => cmp_core(core, &target) == Ordering::Equal,
                _ => unreachable!(),
            };
        }
    }

    // x-range ("0.8.x", "1.x.x") : les composants avant le premier joker
    // doivent correspondre exactement, le reste est libre.
    let components: Vec<&str> = token.split('.').collect();
    if components.iter().any(|c| is_wildcard_component(c)) {
        let prefix: Vec<u64> = components
            .iter()
            .take_while(|c| !is_wildcard_component(c))
            .map(|c| c.parse().unwrap_or(0))
            .collect();
        return core.iter().take(prefix.len()).copied().collect::<Vec<_>>() == prefix;
    }

    // Pas d'opérateur ni de joker : version exacte
    cmp_core(core, &version_core(token)) == Ordering::Equal
}

/// Normalise un numéro de version qui peut porter la version MC et le loader
/// en préfixe (format Modrinth `mc1.21.11-0.8.12-fabric`) ou en suffixe
/// (format fabric.mod.json `0.8.12+mc1.21.11`) — extrait le cœur ("0.8.12")
/// commun aux deux conventions pour que les comparaisons soient cohérentes
/// quelle que soit la source (API Modrinth vs jar local).
pub fn normalize_version(raw: &str, mc_version: &str, loader: &str) -> String {
    let mut s = raw.to_string();

    for prefix in [format!("mc{}-", mc_version), format!("{}-", mc_version)] {
        if let Some(rest) = s.strip_prefix(prefix.as_str()) {
            s = rest.to_string();
            break;
        }
    }

    for suffix in [format!("+mc{}", mc_version), format!("-mc{}", mc_version), format!("+{}", mc_version)] {
        if let Some(rest) = s.strip_suffix(suffix.as_str()) {
            s = rest.to_string();
            break;
        }
    }

    for suffix in [format!("-{}", loader), format!("+{}", loader)] {
        if let Some(rest) = s.strip_suffix(suffix.as_str()) {
            s = rest.to_string();
            break;
        }
    }

    s
}

/// Transforme la valeur JSON de `depends` en groupes OR de jetons ANDés.
/// Une chaîne (">=1.0.0 <2.0.0") = un groupe AND. Un tableau = plusieurs
/// groupes alternatifs (OR), chacun éventuellement lui-même composé de jetons AND.
pub fn parse_predicate_groups(value: &serde_json::Value) -> Vec<Vec<String>> {
    match value {
        serde_json::Value::String(s) => {
            vec![s.split_whitespace().map(|t| t.to_string()).collect()]
        }
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.split_whitespace().map(|t| t.to_string()).collect())
            .collect(),
        _ => Vec::new(),
    }
}

/// Pour `depends` : pas de contrainte déclarée (groupes vides) = tout passe.
pub fn predicate_satisfied(version: &str, groups: &[Vec<String>]) -> bool {
    if groups.is_empty() {
        return true;
    }
    matches_any_group(version, groups)
}

/// Pour `breaks` : pas de plage cassée déclarée (groupes vides) = rien n'est cassé.
/// Inverse de `predicate_satisfied` sur le cas vide — ne pas les confondre.
fn breaks_match(version: &str, groups: &[Vec<String>]) -> bool {
    if groups.is_empty() {
        return false;
    }
    matches_any_group(version, groups)
}

fn matches_any_group(version: &str, groups: &[Vec<String>]) -> bool {
    let core = version_core(version);
    groups
        .iter()
        .any(|group| group.iter().all(|tok| token_satisfied(&core, tok)))
}

/// `depends` doit être satisfait ET `breaks` ne doit matcher aucune version
/// (un mod peut déclarer une plage `depends` large mais exclure certains
/// correctifs cassés via `breaks`, ex: Voxy accepte "0.8.x" sauf 0.8.13).
pub fn version_allowed(version: &str, depends_groups: &[Vec<String>], breaks_groups: &[Vec<String>]) -> bool {
    predicate_satisfied(version, depends_groups) && !breaks_match(version, breaks_groups)
}

/// Lit `fabric.mod.json` d'un jar. Retourne `None` si absent ou invalide.
pub fn read_fabric_mod_json(jar_path: &std::path::Path) -> Option<FabricModJson> {
    use std::io::Read;
    let bytes = std::fs::read(jar_path).ok()?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let mut entry = archive.by_name("fabric.mod.json").ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    serde_json::from_str(&content).ok()
}

#[derive(serde::Deserialize, Default)]
pub struct FabricModJson {
    pub id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub depends: std::collections::HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub breaks: std::collections::HashMap<String, serde_json::Value>,
}
