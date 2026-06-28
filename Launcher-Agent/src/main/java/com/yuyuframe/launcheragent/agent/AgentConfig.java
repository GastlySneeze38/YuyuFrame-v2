package com.yuyuframe.launcheragent.agent;

import java.util.UUID;

/**
 * Configuration passée via : -javaagent:launcher-agent.jar=yarn=...
 */
public class AgentConfig {

    /** ID de session unique par JVM — affichage debug uniquement. */
    public final String instanceId = UUID.randomUUID().toString();
    /**
     * Chemin vers les mappings Yarn tiny v2.
     * Accepte un .tiny direct OU un JAR Yarn mergedv2 (ex: yarn-1.21.1+build.X-mergedv2.jar).
     * Null si non fourni — dans ce cas l'agent tente une auto-détection dans les caches locaux.
     */
    public String yarnPath;

    private static AgentConfig current;

    public static AgentConfig parse(String args) {
        AgentConfig cfg = new AgentConfig();

        if (args != null && !args.isEmpty()) {
            for (String pair : args.split(",")) {
                String[] kv = pair.split("=", 2);
                if (kv.length != 2) continue;
                if ("yarn".equals(kv[0].trim())) {
                    cfg.yarnPath = kv[1].trim();
                }
            }
        }

        current = cfg;
        return cfg;
    }

    public static AgentConfig getCurrent() {
        return current != null ? current : parse(null);
    }
}
