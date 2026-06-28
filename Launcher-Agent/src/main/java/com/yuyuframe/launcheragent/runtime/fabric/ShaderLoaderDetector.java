package com.yuyuframe.launcheragent.runtime.fabric;

/**
 * Détecte la présence d'Iris (ou d'un autre loader de shaders connu) sur le
 * classpath du jeu — condition pour afficher le bouton "Shaders..." dans le
 * menu pause (un shaderpack installé sans loader compatible ne fait rien).
 *
 * Aucune dépendance de compilation sur Iris : juste une vérification
 * Class.forName par réflexion, comme isFabricPresent() dans LauncherAgent.
 */
public final class ShaderLoaderDetector {

    private ShaderLoaderDetector() {}

    /**
     * Classes-marqueurs connues, une par loader/version de package. Iris a
     * renommé son package racine de "net.coderbot.iris" vers
     * "net.irisshaders.iris" autour de la 1.7 — on vérifie les deux pour
     * couvrir les anciennes comme les récentes installations.
     */
    private static final String[] MARKER_CLASSES = {
        "net.irisshaders.iris.Iris",
        "net.coderbot.iris.Iris",
    };

    public static boolean isPresent(ClassLoader cl) {
        for (String name : MARKER_CLASSES) {
            try {
                Class.forName(name, false, cl);
                return true;
            } catch (Throwable ignored) {}
        }
        return false;
    }
}
