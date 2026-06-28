package com.yuyuframe.launcheragent.runtime.log;

/**
 * Gestion centralisée des logs LauncherAgent avec niveaux de priorité par catégorie.
 *
 * Niveau d'un appel   : 1=verbose  2=info  3=critique
 * Seuil d'une catégorie : 0=désactivé  1=tout  2=info+critique  3=critique seul
 *
 * Un log s'affiche si : seuil > 0  ET  niveau_appel >= seuil
 */
public final class LauncherLog {

    private LauncherLog() {}

    /** Modification d'UI Minecraft — ScreenHelper, mixins clients. */
    public static volatile int UI    = 3;
    /** Patches ASM au démarrage. */
    public static volatile int ASM   = 3;
    /** Scan/retransform de l'agent Java au démarrage. */
    public static volatile int AGENT = 3;
    /** Recherche/téléchargement Modrinth. */
    public static volatile int CONTENT = 3;

    public static volatile boolean SHOW_CATEGORY = true;

    public static void loadConfig(java.util.Properties p) {
        UI      = intProp(p, "log.ui",      UI);
        ASM     = intProp(p, "log.asm",     ASM);
        AGENT   = intProp(p, "log.agent",   AGENT);
        CONTENT = intProp(p, "log.content", CONTENT);
        SHOW_CATEGORY = boolProp(p, "log.show_category", SHOW_CATEGORY);
    }

    private static int intProp(java.util.Properties p, String key, int fallback) {
        try { return Integer.parseInt(p.getProperty(key, String.valueOf(fallback)).trim()); }
        catch (NumberFormatException ignored) { return fallback; }
    }

    private static boolean boolProp(java.util.Properties p, String key, boolean fallback) {
        String v = p.getProperty(key);
        return v != null ? "true".equalsIgnoreCase(v.trim()) : fallback;
    }

    public static void ui(String msg)      { log("UI",      UI,      2, msg); }
    public static void asm(String msg)     { log("ASM",     ASM,     2, msg); }
    public static void agent(String msg)   { log("AGENT",   AGENT,   2, msg); }
    public static void content(String msg) { log("CONTENT", CONTENT, 2, msg); }

    public static void ui(int lvl, String msg)      { log("UI",      UI,      lvl, msg); }
    public static void asm(int lvl, String msg)     { log("ASM",     ASM,     lvl, msg); }
    public static void agent(int lvl, String msg)   { log("AGENT",   AGENT,   lvl, msg); }
    public static void content(int lvl, String msg) { log("CONTENT", CONTENT, lvl, msg); }

    public static void info(String msg) { System.out.println(msg); }

    public static Fatal fatal(String msg) {
        System.err.println("[FATAL] " + msg);
        throw new Fatal(msg);
    }

    public static final class Fatal extends RuntimeException {
        public Fatal(String msg) { super(msg); }
    }

    public static void err(String msg)  { System.err.println("[ERR] " + msg); }
    public static void warn(String msg) { System.err.println("[WARN] " + msg); }

    private static void log(String category, int threshold, int level, String msg) {
        if (threshold == 0 || level < threshold) return;
        String line = (level >= 3 ? "[!] " : "")
                    + (SHOW_CATEGORY ? "[" + category + "] " : "")
                    + msg;
        System.out.println(line);
    }
}
