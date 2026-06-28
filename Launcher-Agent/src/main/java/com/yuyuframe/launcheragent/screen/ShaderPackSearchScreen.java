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
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Écran de recherche/installation de shader packs Modrinth, ouvert depuis le
 * menu pause (voir GameMenuScreenMixin) quand Iris (ou un autre loader de
 * shaders) est détecté. Copie quasi-identique de ResourcePackSearchScreen —
 * seules différences : project_type Modrinth ("shader"), dossier de
 * destination (shaderpacks au lieu de resourcepacks) et textes d'écran. Voir
 * ResourcePackSearchScreen pour les commentaires détaillés sur chaque
 * mécanisme (scroll par déplacement de widgets, icônes, etc.) — non répétés
 * ici pour éviter la duplication de documentation.
 */
public class ShaderPackSearchScreen extends Screen {

    private static final int ROW_SLOTS = 24;
    private static final int RESULTS_Y = 100;
    private static final int RESULTS_SPACING = 26;
    private static final int RESULTS_HEIGHT = 22;
    private static final int FOOTER_MARGIN = 36;
    private static final int ICON_SIZE = 20;
    private static final int ICON_GAP = 4;

    private int visibleResults;
    private int viewportBottom;

    private final Object lastScreen;
    private final Path shaderPacksDir;
    private final Object mc;

    private Object searchBox;
    private Object statusLabel;
    private final Object[] descButtons = new Object[ROW_SLOTS];
    private final Object[] installButtons = new Object[ROW_SLOTS];
    private final Object[] iconWidgets = new Object[ROW_SLOTS];
    private List<ModrinthJson.Hit> allHits = new ArrayList<>();
    private int scrollOffset = 0;
    private volatile boolean busy = false;
    private int descX;
    private int installX;
    private int iconX;
    private final AtomicInteger searchGeneration = new AtomicInteger();

    public ShaderPackSearchScreen(Object lastScreen, Path shaderPacksDir) {
        super((Component) ScreenHelper.literal("Modrinth — Shader Packs"));
        this.lastScreen = lastScreen;
        this.shaderPacksDir = shaderPacksDir;
        this.mc = ScreenHelper.getMc(this);
    }

    public void bg_() {
        int w = ScreenHelper.getWidth(this);
        int h = ScreenHelper.getHeight(this);
        int cx = w / 2;

        ScreenHelper.addTitleLabel(this, "§lModrinth — Shader Packs", 18);

        searchBox = ScreenHelper.createEditBox(this, cx - 155, 42, 230, 20);
        if (searchBox != null) {
            ScreenHelper.setEditBoxMaxLength(searchBox, 64);
            ScreenHelper.addWidget(this, searchBox);
            ScreenHelper.setEditBoxHint(searchBox, "Nom du shader pack...");
        }
        ScreenHelper.addButton(this, cx + 80, 42, 75, 20, "Chercher", this::handleSearch);

        descX = cx - 155;
        installX = cx + 80;
        iconX = descX - ICON_GAP - ICON_SIZE;

        statusLabel = ScreenHelper.addButton(this, cx - 155, 70, 310, 16, "", () -> {});
        ScreenHelper.setActive(statusLabel, false);
        ScreenHelper.setVisible(statusLabel, false);

        viewportBottom = h - FOOTER_MARGIN;
        visibleResults = Math.max(1, Math.min(ROW_SLOTS, (viewportBottom - RESULTS_Y) / RESULTS_SPACING));

        for (int i = 0; i < ROW_SLOTS; i++) {
            final int idx = i;
            Object descBtn = ScreenHelper.addButton(this, descX, RESULTS_Y, 230, RESULTS_HEIGHT, "",
                () -> openDetail(idx));
            ScreenHelper.setActive(descBtn, false);
            ScreenHelper.setVisible(descBtn, false);
            descButtons[i] = descBtn;

            Object installBtn = ScreenHelper.addButton(this, installX, RESULTS_Y, 75, RESULTS_HEIGHT, "Installer",
                () -> handleInstall(idx));
            ScreenHelper.setActive(installBtn, false);
            ScreenHelper.setVisible(installBtn, false);
            installButtons[i] = installBtn;
        }

        int arrowsX = installX + 75 + 4;
        ScreenHelper.addButton(this, arrowsX, RESULTS_Y, 16, 16, "▲", () -> scrollBy(-1));
        ScreenHelper.addButton(this, arrowsX, viewportBottom - 16, 16, 16, "▼", () -> scrollBy(1));

        ScreenHelper.addButton(this, cx - 100, h - 28, 200, 20, "Retour",
            () -> ScreenHelper.navigate(this, lastScreen));

        triggerSearch("");
    }

    private void scrollBy(int delta) {
        if (allHits.size() <= visibleResults) return;
        int maxOffset = Math.max(0, allHits.size() - visibleResults);
        int newOffset = Math.max(0, Math.min(maxOffset, scrollOffset + delta));
        if (newOffset != scrollOffset) {
            scrollOffset = newOffset;
            repositionSlots();
        }
    }

    public boolean a(double mouseX, double mouseY, double horizontalAmount, double verticalAmount) {
        int delta = verticalAmount > 0 ? -1 : (verticalAmount < 0 ? 1 : 0);
        if (delta == 0) return false;
        int before = scrollOffset;
        scrollBy(delta);
        return scrollOffset != before || allHits.size() > visibleResults;
    }

    private void handleSearch() {
        String query = ScreenHelper.editBoxValue(searchBox);
        triggerSearch(query == null ? "" : query.trim());
    }

    private void triggerSearch(String query) {
        if (busy) return;
        busy = true;
        setStatus(query.isEmpty() ? "§7Recommandations en cours..." : "§7Recherche en cours...");

        Thread t = new Thread(() -> doSearch(query), "LauncherAgent-Search");
        t.setDaemon(true);
        t.start();
    }

    private void doSearch(String query) {
        try {
            if (!ContentBridge.ensureLoaded()) {
                onMc(() -> setStatus("§ccontent_core.dll indisponible"));
                return;
            }
            String json = ContentBridge.searchModrinth(query, "shader");
            String error = ModrinthJson.jsonString(json, "error");
            if (error != null) {
                onMc(() -> setStatus("§cErreur Modrinth : " + error));
                return;
            }
            List<ModrinthJson.Hit> hits = ModrinthJson.parseHits(json, ROW_SLOTS);
            onMc(() -> showResults(hits));
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent-Screen] doSearch (shader): " + t);
            onMc(() -> setStatus("§cErreur recherche : " + t.getMessage()));
        } finally {
            busy = false;
        }
    }

    private void showResults(List<ModrinthJson.Hit> hits) {
        allHits = hits;
        scrollOffset = 0;
        int generation = searchGeneration.incrementAndGet();
        setStatus(hits.isEmpty() ? "§7Aucun résultat"
            : "§7" + hits.size() + " résultat(s)" + (hits.size() > visibleResults ? " §8— molette ou ▲▼ pour défiler" : ""));

        for (int i = 0; i < ROW_SLOTS; i++) {
            if (i >= allHits.size()) {
                ScreenHelper.setButtonLabel(this, descButtons[i], "");
                ScreenHelper.setVisible(iconWidgets[i], false);
            } else {
                ScreenHelper.setButtonLabel(this, descButtons[i], formatResultLabel(this, allHits.get(i)));
            }
        }
        refreshInstalledBadges();
        repositionSlots();
        loadIconsAsync(generation);
    }

    private void loadIconsAsync(int generation) {
        List<ModrinthJson.Hit> hits = allHits;
        Thread t = new Thread(() -> {
            for (int i = 0; i < hits.size(); i++) {
                if (searchGeneration.get() != generation) return;
                ModrinthJson.Hit hit = hits.get(i);
                if (hit.iconUrl == null || hit.iconUrl.isEmpty()) continue;

                Path cacheFile = IconWidgets.cacheFile(hit.projectId);
                if (!java.nio.file.Files.isRegularFile(cacheFile)) {
                    if (!ContentBridge.ensureLoaded()) return;
                    boolean ok = ContentBridge.downloadFile(hit.iconUrl, cacheFile.toString());
                    if (!ok) continue;
                }

                final int idx = i;
                onMc(() -> {
                    if (searchGeneration.get() != generation) return;
                    attachIcon(idx, hit, cacheFile);
                });
            }
        }, "LauncherAgent-Icons");
        t.setDaemon(true);
        t.start();
    }

    private void attachIcon(int slot, ModrinthJson.Hit hit, Path cacheFile) {
        Object existing = iconWidgets[slot];
        if (existing != null) {
            Object identifier = IconWidgets.getOrRegisterIdentifier(this, hit.projectId, cacheFile, ICON_SIZE);
            if (identifier == null) return;
            IconWidgets.setTexture(existing, identifier);
            ScreenHelper.setVisible(existing, true);
            return;
        }
        Object widget = IconWidgets.loadIconWidget(this, hit.projectId, cacheFile,
            iconX, RESULTS_Y + (slot - scrollOffset) * RESULTS_SPACING, ICON_SIZE);
        if (widget == null) return;
        ScreenHelper.addWidget(this, widget);
        iconWidgets[slot] = widget;
        repositionSlots();
    }

    private void refreshInstalledBadges() {
        Set<String> installed = scanInstalledNormalizedNames();
        for (int i = 0; i < allHits.size(); i++) {
            boolean alreadyInstalled = isInstalled(allHits.get(i), installed);
            ScreenHelper.setButtonLabel(this, installButtons[i], alreadyInstalled ? "§a✔ Installé" : "Installer");
            ScreenHelper.setActive(installButtons[i], !alreadyInstalled);
        }
    }

    private void repositionSlots() {
        for (int i = 0; i < ROW_SLOTS; i++) {
            Object descBtn = descButtons[i];
            Object installBtn = installButtons[i];
            Object iconWidget = iconWidgets[i];
            boolean hasHit = i < allHits.size();
            int y = RESULTS_Y + (i - scrollOffset) * RESULTS_SPACING;
            boolean inViewport = hasHit && y >= RESULTS_Y && y + RESULTS_HEIGHT <= viewportBottom;
            boolean iconHasContent = hasHit && allHits.get(i).iconUrl != null && !allHits.get(i).iconUrl.isEmpty();

            ScreenHelper.setPosition(descBtn, descX, y);
            ScreenHelper.setPosition(installBtn, installX, y);
            ScreenHelper.setVisible(descBtn, inViewport);
            ScreenHelper.setVisible(installBtn, inViewport);
            if (inViewport) ScreenHelper.setActive(descBtn, true);

            if (iconWidget != null) {
                ScreenHelper.setPosition(iconWidget, iconX, y);
                ScreenHelper.setVisible(iconWidget, inViewport && iconHasContent);
            }
        }
    }

    private static String formatResultLabel(Object screen, ModrinthJson.Hit hit) {
        int maxWidth = 230 - 8;

        String meta = "";
        if (hit.author != null && !hit.author.isEmpty()) meta += "  §7par " + hit.author;
        if (hit.downloads > 0) meta += "  §8• §7⬇ " + formatCount(hit.downloads);

        String full = "§f§l" + hit.title + "§r" + meta;
        if (ScreenHelper.textWidth(screen, full) <= maxWidth) return full;

        String titleOnly = "§f§l" + hit.title + "§r";
        if (ScreenHelper.textWidth(screen, titleOnly) <= maxWidth) return titleOnly;

        String title = hit.title;
        while (!title.isEmpty() && ScreenHelper.textWidth(screen, "§f§l" + title + "…§r") > maxWidth) {
            title = title.substring(0, title.length() - 1);
        }
        return "§f§l" + title + "…§r";
    }

    private static String formatCount(long n) {
        if (n >= 1_000_000) return String.format("%.1fM", n / 1_000_000.0);
        if (n >= 1_000) return String.format("%.1fk", n / 1_000.0);
        return String.valueOf(n);
    }

    private Set<String> scanInstalledNormalizedNames() {
        Set<String> names = new HashSet<>();
        try {
            if (java.nio.file.Files.isDirectory(shaderPacksDir)) {
                try (var stream = java.nio.file.Files.list(shaderPacksDir)) {
                    stream.forEach(p -> names.add(normalize(p.getFileName().toString())));
                }
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] scanInstalled (shader): " + e);
        }
        return names;
    }

    private static boolean isInstalled(ModrinthJson.Hit hit, Set<String> installedNormalizedNames) {
        String needle = normalize(hit.title);
        if (needle.isEmpty()) return false;
        for (String name : installedNormalizedNames) {
            if (name.contains(needle)) return true;
        }
        return false;
    }

    private static String normalize(String s) {
        return s == null ? "" : s.toLowerCase().replaceAll("[^a-z0-9]", "");
    }

    private void openDetail(int slot) {
        if (slot >= allHits.size()) return;
        ModrinthJson.Hit hit = allHits.get(slot);
        ScreenHelper.navigate(this, new ShaderPackDetailScreen(this, hit, shaderPacksDir));
    }

    private void handleInstall(int slot) {
        if (busy || slot >= allHits.size()) return;
        ModrinthJson.Hit hit = allHits.get(slot);

        busy = true;
        setStatus("§7Téléchargement de §f" + hit.title + "§7...");

        Thread t = new Thread(() -> doInstall(hit), "LauncherAgent-Install");
        t.setDaemon(true);
        t.start();
    }

    private void doInstall(ModrinthJson.Hit hit) {
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

            Path dest = shaderPacksDir.resolve(filename);
            boolean ok = ContentBridge.downloadFile(url, dest.toString());

            onMc(() -> {
                setStatus(ok
                    ? "§a✔ " + hit.title + " installé §7— ouvre les options de shaders (Iris) pour l'activer"
                    : "§cÉchec du téléchargement de " + hit.title);
                if (ok) refreshInstalledBadges();
            });
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent-Screen] doInstall (shader): " + t);
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
