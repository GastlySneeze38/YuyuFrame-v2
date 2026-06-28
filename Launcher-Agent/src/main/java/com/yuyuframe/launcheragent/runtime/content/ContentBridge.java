package com.yuyuframe.launcheragent.runtime.content;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;

/**
 * Pont Java → Rust via JNI dédié à LauncherAgent.
 * Charge content_core.dll depuis %APPDATA%\YuyuFrame\agent\ — DLL
 * séparée de rust_core.dll (p2p), déployée dans son propre sous-dossier
 * pour ne jamais mélanger les deux agents (voir docs/LauncherAgent/index.md).
 *
 * Contrairement à RustBridge (p2p), cette bibliothèque n'est PAS obligatoire
 * au démarrage de la JVM : la fonctionnalité resource packs est une feature
 * in-game optionnelle, pas un prérequis du jeu. Le chargement est donc
 * paresseux et non-fatal — ensureLoaded() est appelé au premier usage réel
 * (ouverture de l'écran resource packs), pas depuis premain().
 */
public final class ContentBridge {

    private static volatile boolean loaded = false;
    private static volatile boolean loadAttempted = false;

    private ContentBridge() {}

    /** Tente de charger content_core.dll si pas déjà fait. Sûr à appeler plusieurs fois. */
    public static synchronized boolean ensureLoaded() {
        if (loaded) return true;
        if (loadAttempted) return false;
        loadAttempted = true;

        String appData = System.getenv("APPDATA");
        String path = appData != null
            ? appData + "\\YuyuFrame\\agent\\content_core.dll"
            : "content_core (via java.library.path)";
        try {
            if (appData != null) System.load(appData + "\\YuyuFrame\\agent\\content_core.dll");
            else System.loadLibrary("content_core");
            loaded = true;
            LauncherLog.content(3, "[LauncherAgent] content_core.dll chargée");
        } catch (UnsatisfiedLinkError e) {
            LauncherLog.warn("[LauncherAgent] content_core.dll introuvable (" + path
                + ") — recherche/installation Modrinth indisponible pour cette session");
        }
        return loaded;
    }

    public static boolean isLoaded() { return loaded; }

    // ── Fonctions JNI — implémentées dans content-core/src/jni/content.rs ────

    /** Recherche Modrinth (resource packs). Retourne le JSON brut, parsé côté Java. */
    public static native String searchModrinth(String query, String projectType);

    /**
     * Résout le fichier de la dernière version d'un projet Modrinth.
     * Retourne {@code {"url":"...","filename":"..."}} ou {@code {"error":"..."}}.
     */
    public static native String getLatestFile(String projectId);

    /** Télécharge un fichier vers destPath. */
    public static native boolean downloadFile(String url, String destPath);
}
