package com.yuyuframe.launcheragent.runtime.keybind;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Properties;

/**
 * Préférences persistées pour l'écran Controls amélioré (voir
 * ControlsListWidgetMixin/KeybindsScreenMixin) — séparé de
 * launcher-agent.properties (config statique livrée avec le jar) puisque ce
 * fichier est modifié EN JEU et doit survivre aux mises à jour de l'agent.
 *
 * v1 : juste "afficher les touches non assignées" (décoché par défaut, voir
 * choix utilisateur). Les étapes suivantes (groupes par mod repliés par
 * défaut, catégorie config/ModMenu, fréquence d'usage) ajouteront leurs
 * propres clés ici au fur et à mesure.
 */
public final class KeybindSettings {

    private KeybindSettings() {}

    private static volatile boolean loaded = false;
    private static volatile boolean showUnbound = false;
    /**
     * Catégories explicitement DÉPLIÉES — toute catégorie absente de cet
     * ensemble est considérée repliée (choix utilisateur : repliées par
     * défaut). Représentation par "expandé" plutôt que "replié" pour que les
     * catégories ajoutées par un nouveau mod soient repliées par défaut sans
     * action de notre part (pas besoin de les ajouter explicitement nulle part).
     */
    private static final java.util.Set<String> expandedCategories =
        java.util.concurrent.ConcurrentHashMap.newKeySet();

    private static Path file() {
        String appData = System.getenv("APPDATA");
        Path dir = appData != null
            ? Paths.get(appData, "YuyuFrame", "agent")
            : Paths.get(".");
        return dir.resolve("keybinds-ui.properties");
    }

    private static synchronized void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        Properties p = new Properties();
        try (var in = Files.newInputStream(file())) {
            p.load(in);
            showUnbound = Boolean.parseBoolean(p.getProperty("showUnbound", "false"));
            String expanded = p.getProperty("expandedCategories", "");
            if (!expanded.isEmpty()) {
                for (String id : expanded.split(",")) {
                    if (!id.isBlank()) expandedCategories.add(id);
                }
            }
        } catch (IOException ignored) {
            // Fichier absent au premier lancement — valeurs par défaut déjà posées.
        }
    }

    public static boolean isShowUnbound() {
        ensureLoaded();
        return showUnbound;
    }

    public static synchronized void setShowUnbound(boolean value) {
        ensureLoaded();
        showUnbound = value;
        save();
    }

    public static boolean isCategoryExpanded(String categoryId) {
        ensureLoaded();
        return expandedCategories.contains(categoryId);
    }

    public static synchronized void setCategoryExpanded(String categoryId, boolean expanded) {
        ensureLoaded();
        if (expanded) expandedCategories.add(categoryId);
        else expandedCategories.remove(categoryId);
        save();
    }

    private static void save() {
        Properties p = new Properties();
        p.setProperty("showUnbound", String.valueOf(showUnbound));
        p.setProperty("expandedCategories", String.join(",", expandedCategories));
        try {
            Path f = file();
            Files.createDirectories(f.getParent());
            try (var out = Files.newOutputStream(f)) {
                p.store(out, "LauncherAgent — préférences écran Controls (généré, ne pas éditer à la main)");
            }
        } catch (IOException e) {
            LauncherLog.warn("[LauncherAgent] KeybindSettings.save: " + e);
        }
    }
}
