package com.yuyuframe.launcheragent.screen;

import com.yuyuframe.launcheragent.runtime.content.ContentBridge;
import com.yuyuframe.launcheragent.runtime.content.ModrinthJson;
import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.screen.IconWidgets;
import com.yuyuframe.launcheragent.runtime.screen.ScreenHelper;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Écran de détail d'un resource pack Modrinth, ouvert en cliquant sur la
 * description d'un résultat dans ResourcePackSearchScreen. Cahier des
 * charges : docs/LauncherAgent/index.md.
 *
 * Patché par ScreenStubPatcher au chargement (voir LauncherMixinTransformerWrapper)
 * exactement comme ResourcePackSearchScreen — même besoin de remap stub Screen/Text.
 *
 * Icône du pack via le vrai widget vanilla IconWidget (voir IconWidgets et
 * ResourcePackSearchScreen) — pas de surcharge du rendu de l'écran.
 */
public class ResourcePackDetailScreen extends Screen {

    private static final int WRAP_CHARS = 58;
    private static final int MAX_DESC_LINES = 8;
    private static final int ICON_SIZE = 32;
    private static final int ICON_GAP = 8;

    private final Object lastScreen;
    private final ModrinthJson.Hit hit;
    private final Path resourcePacksDir;
    private final Object mc;

    private Object statusLabel;
    private Object installButton;
    private volatile boolean busy = false;

    public ResourcePackDetailScreen(Object lastScreen, ModrinthJson.Hit hit, Path resourcePacksDir) {
        super((Component) ScreenHelper.literal(hit.title));
        this.lastScreen = lastScreen;
        this.hit = hit;
        this.resourcePacksDir = resourcePacksDir;
        this.mc = ScreenHelper.getMc(this);
    }

    public void bg_() {
        int w = ScreenHelper.getWidth(this);
        int h = ScreenHelper.getHeight(this);
        int cx = w / 2;

        ScreenHelper.addTitleLabel(this, "§l" + hit.title, 16);

        // Texte décalé à droite de l'icône (chargée en arrière-plan plus bas) —
        // largeur réduite en conséquence pour ne pas chevaucher.
        int textX = cx - 155 + ICON_SIZE + ICON_GAP;
        int textWidth = 310 - ICON_SIZE - ICON_GAP;

        int y = 40;
        String meta = "§7par " + (hit.author != null ? hit.author : "?")
                + "  §8• §7⬇ " + formatCount(hit.downloads);
        Object metaLabel = ScreenHelper.addButton(this, textX, y, textWidth, 14, meta, () -> {});
        ScreenHelper.setActive(metaLabel, false);
        y += 22;

        for (String line : wrapDescription(hit.description)) {
            Object lbl = ScreenHelper.addButton(this, textX, y, textWidth, 14, "§7" + line, () -> {});
            ScreenHelper.setActive(lbl, false);
            y += 14;
        }

        loadIconAsync(cx - 155, 40);

        statusLabel = ScreenHelper.addButton(this, cx - 155, h - 56, 310, 16, "", () -> {});
        ScreenHelper.setActive(statusLabel, false);
        ScreenHelper.setVisible(statusLabel, false);

        installButton = ScreenHelper.addButton(this, cx - 155, h - 30, 150, 20, "Installer", this::handleInstall);
        ScreenHelper.addButton(this, cx + 5, h - 30, 150, 20, "Retour",
            () -> ScreenHelper.navigate(this, lastScreen));

        if (isAlreadyInstalled()) {
            ScreenHelper.setButtonLabel(this, installButton, "§a✔ Installé");
            ScreenHelper.setActive(installButton, false);
        }
    }

    /** Télécharge (si pas déjà en cache) puis affiche l'icône Modrinth du pack — un seul widget, créé une fois. */
    private void loadIconAsync(int x, int y) {
        if (hit.iconUrl == null || hit.iconUrl.isEmpty()) return;
        Thread t = new Thread(() -> {
            Path cacheFile = IconWidgets.cacheFile(hit.projectId);
            if (!java.nio.file.Files.isRegularFile(cacheFile)) {
                if (!ContentBridge.ensureLoaded()) return;
                if (!ContentBridge.downloadFile(hit.iconUrl, cacheFile.toString())) return;
            }
            onMc(() -> {
                Object widget = IconWidgets.loadIconWidget(this, hit.projectId, cacheFile, x, y, ICON_SIZE);
                if (widget != null) ScreenHelper.addWidget(this, widget);
            });
        }, "LauncherAgent-Icon-Detail");
        t.setDaemon(true);
        t.start();
    }

    /** Même heuristique (substring sur le nom de fichier normalisé) que ResourcePackSearchScreen. */
    private boolean isAlreadyInstalled() {
        String needle = normalize(hit.title);
        if (needle.isEmpty()) return false;
        try {
            if (!java.nio.file.Files.isDirectory(resourcePacksDir)) return false;
            try (var stream = java.nio.file.Files.list(resourcePacksDir)) {
                return stream.anyMatch(p -> normalize(p.getFileName().toString()).contains(needle));
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] isAlreadyInstalled: " + e);
            return false;
        }
    }

    private static String normalize(String s) {
        return s == null ? "" : s.toLowerCase().replaceAll("[^a-z0-9]", "");
    }

    private List<String> wrapDescription(String description) {
        List<String> lines = new ArrayList<>();
        if (description == null || description.isEmpty()) {
            lines.add("Aucune description disponible.");
            return lines;
        }
        String[] words = description.replace('\n', ' ').trim().split("\\s+");
        StringBuilder current = new StringBuilder();
        for (String word : words) {
            if (current.length() + word.length() + 1 > WRAP_CHARS) {
                lines.add(current.toString());
                current.setLength(0);
                if (lines.size() >= MAX_DESC_LINES) break;
            }
            if (current.length() > 0) current.append(' ');
            current.append(word);
        }
        if (current.length() > 0 && lines.size() < MAX_DESC_LINES) lines.add(current.toString());
        return lines;
    }

    private static String formatCount(long n) {
        if (n >= 1_000_000) return String.format("%.1fM", n / 1_000_000.0);
        if (n >= 1_000) return String.format("%.1fk", n / 1_000.0);
        return String.valueOf(n);
    }

    private void handleInstall() {
        if (busy) return;
        busy = true;
        setStatus("§7Téléchargement de §f" + hit.title + "§7...");

        Thread t = new Thread(this::doInstall, "LauncherAgent-Install-Detail");
        t.setDaemon(true);
        t.start();
    }

    private void doInstall() {
        try {
            String fileJson = ContentBridge.getLatestFile(hit.projectId);
            String error = ModrinthJson.jsonString(fileJson, "error");
            if (error != null) {
                onMc(() -> setStatus("§cErreur Modrinth : " + error));
                return;
            }
            String url = ModrinthJson.jsonString(fileJson, "url");
            String filename = ModrinthJson.jsonString(fileJson, "filename");
            if (url == null || filename == null) {
                onMc(() -> setStatus("§cAucun fichier disponible pour " + hit.title));
                return;
            }

            Path dest = resourcePacksDir.resolve(filename);
            boolean ok = ContentBridge.downloadFile(url, dest.toString());

            onMc(() -> {
                setStatus(ok
                    ? "§a✔ " + hit.title + " installé §7— visible dans la liste \"Disponibles\""
                    : "§cÉchec du téléchargement de " + hit.title);
                if (ok) {
                    ScreenHelper.setButtonLabel(this, installButton, "§a✔ Installé");
                    ScreenHelper.setActive(installButton, false);
                }
            });
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent-Screen] doInstall (detail): " + t);
            onMc(() -> setStatus("§cErreur installation : " + t.getMessage()));
        } finally {
            busy = false;
        }
    }

    private void setStatus(String text) {
        ScreenHelper.setButtonLabel(this, statusLabel, text);
        ScreenHelper.setVisible(statusLabel, text != null && !text.isEmpty());
    }

    private void onMc(Runnable task) {
        ScreenHelper.executeOnMc(mc, task);
    }
}
