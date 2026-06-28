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
 * Écran de recherche/installation de resource packs Modrinth, ouvert depuis
 * l'écran vanilla Resource Packs (voir PackScreenMixin). Cahier des charges :
 * docs/LauncherAgent/index.md.
 *
 * v1.2 — vrai défilement par déplacement de widgets : ROW_SLOTS (jusqu'à
 * FETCH_LIMIT) paires de boutons description/installer sont créées une fois,
 * chacune avec un index de ligne fixe. Au scroll, on déplace réellement leurs
 * coordonnées Y (ScreenHelper.setPosition) et on cache (setVisible) celles qui
 * sortent de la fenêtre visible [RESULTS_Y, viewportBottom[ (calculée selon la
 * hauteur réelle de l'écran, voir bg_()) —
 * ça donne un vrai effet de glissement sans avoir besoin d'un scissor GPU
 * (DrawContext), qu'on ne peut pas câbler de façon fiable sans pouvoir
 * compiler/tester en jeu (voir note dans docs/LauncherAgent/index.md).
 */
public class ResourcePackSearchScreen extends Screen {

    private static final int ROW_SLOTS = 24; // = FETCH_LIMIT : un widget réel par résultat possible
    private static final int RESULTS_Y = 100;
    private static final int RESULTS_SPACING = 26;
    private static final int RESULTS_HEIGHT = 22;
    private static final int FOOTER_MARGIN = 36; // espace réservé au-dessus du bouton Retour
    private static final int ICON_SIZE = 20;
    private static final int ICON_GAP = 4;

    // Calculés dans bg_() à partir de la hauteur réelle de l'écran — bg_() est
    // ré-exécuté au resize (Screen.resize() → clearAndInit() → init()), donc
    // recalculer ici suffit à corriger le layout sans logique de resize séparée.
    private int visibleResults;
    private int viewportBottom;

    private final Object lastScreen;
    private final Path resourcePacksDir;
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

    public ResourcePackSearchScreen(Object lastScreen, Path resourcePacksDir) {
        super((Component) ScreenHelper.literal("Modrinth — Resource Packs"));
        this.lastScreen = lastScreen;
        this.resourcePacksDir = resourcePacksDir;
        this.mc = ScreenHelper.getMc(this);
    }

    public void bg_() {
        int w = ScreenHelper.getWidth(this);
        int h = ScreenHelper.getHeight(this);
        int cx = w / 2;

        ScreenHelper.addTitleLabel(this, "§lModrinth — Resource Packs", 18);

        searchBox = ScreenHelper.createEditBox(this, cx - 155, 42, 230, 20);
        if (searchBox != null) {
            ScreenHelper.setEditBoxMaxLength(searchBox, 64);
            ScreenHelper.addWidget(this, searchBox);
            ScreenHelper.setEditBoxHint(searchBox, "Nom du resource pack...");
        }
        ScreenHelper.addButton(this, cx + 80, 42, 75, 20, "Chercher", this::handleSearch);

        descX = cx - 155;
        installX = cx + 80;
        iconX = descX - ICON_GAP - ICON_SIZE;

        statusLabel = ScreenHelper.addButton(this, cx - 155, 70, 310, 16, "", () -> {});
        ScreenHelper.setActive(statusLabel, false);
        ScreenHelper.setVisible(statusLabel, false);

        // Hauteur dispo entre le haut de la liste et le bouton Retour — recalculé
        // ici à chaque (re)init, donc correct aussi après un resize de fenêtre
        // (Screen.resize() relance bg_() via clearAndInit()).
        viewportBottom = h - FOOTER_MARGIN;
        visibleResults = Math.max(1, Math.min(ROW_SLOTS, (viewportBottom - RESULTS_Y) / RESULTS_SPACING));

        // Tous les slots existent dès le départ, hors-écran/cachés par défaut —
        // c'est le repositionnement (pas la recréation) qui donne l'effet de
        // scroll au moment où repositionSlots() les place dans la fenêtre.
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

        // Boutons ▲▼ cliquables à la souris, en plus de la molette — une vraie
        // poignée de scrollbar à glisser demanderait de surcharger
        // Element.mouseDragged, dont le descripteur prend un objet "Click"
        // (record interne, classe non documentée dans les stubs) plutôt que des
        // doubles bruts comme mouseScrolled : même niveau de risque à l'aveugle
        // que le rendu d'images, donc pas tenté sans pouvoir compiler/tester.
        int arrowsX = installX + 75 + 4;
        ScreenHelper.addButton(this, arrowsX, RESULTS_Y, 16, 16, "▲", () -> scrollBy(-1));
        ScreenHelper.addButton(this, arrowsX, viewportBottom - 16, 16, 16, "▼", () -> scrollBy(1));

        ScreenHelper.addButton(this, cx - 100, h - 28, 200, 20, "Retour",
            () -> ScreenHelper.navigate(this, lastScreen));

        // Recommandations à l'ouverture : recherche vide → content-core trie
        // par popularité (voir modrinth.rs::search_modrinth, index=downloads).
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

    // ── Molette : déplace réellement les widgets visibles ───────────────────────
    //
    // Override polymorphique réel (pas de la réflexion) : Element.mouseScrolled
    // a pour signature obfusquée "a(DDDD)Z" (mouseX, mouseY, horizontalAmount,
    // verticalAmount). Une fois ScreenStubPatcher passé, notre superclasse est
    // la vraie classe Screen obfusquée qui implémente cette interface — le JVM
    // résout l'appel virtuel par nom+descripteur, donc cette méthode est bien
    // appelée par le jeu sans qu'on ait besoin du stub pour le déclarer. Même
    // principe que bg_() pour init().
    public boolean a(double mouseX, double mouseY, double horizontalAmount, double verticalAmount) {
        int delta = verticalAmount > 0 ? -1 : (verticalAmount < 0 ? 1 : 0);
        if (delta == 0) return false;
        int before = scrollOffset;
        scrollBy(delta);
        return scrollOffset != before || allHits.size() > visibleResults;
    }

    // ── Recherche ──────────────────────────────────────────────────────────────

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
            String json = ContentBridge.searchModrinth(query, "resourcepack");
            String error = ModrinthJson.jsonString(json, "error");
            if (error != null) {
                onMc(() -> setStatus("§cErreur Modrinth : " + error));
                return;
            }
            List<ModrinthJson.Hit> hits = ModrinthJson.parseHits(json, ROW_SLOTS);
            onMc(() -> showResults(hits));
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent-Screen] doSearch: " + t);
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

    /**
     * Télécharge (si pas déjà en cache) puis attache l'icône Modrinth de
     * chaque résultat ayant un icon_url, via le vrai widget vanilla IconWidget
     * (voir IconWidgets) — pas de surcharge de rendu. {@code generation}
     * protège contre une recherche suivante qui aurait déjà invalidé
     * {@code allHits} avant que le téléchargement précédent ne finisse.
     */
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

    /**
     * Attache/rafraîchit l'icône d'une ligne. Si un IconWidget existe déjà à
     * ce slot (réutilisé d'une recherche précédente), on change juste sa
     * texture (IconWidgets.setTexture) — pas de removeWidget fiable côté
     * réflexion, donc on ne crée un nouveau widget qu'une fois par slot.
     */
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
        repositionSlots(); // applique tout de suite la bonne position/visibilité au nouveau widget
    }

    /** Recalcule le badge "Installé"/"Installer" de chaque ligne sans toucher au scroll. */
    private void refreshInstalledBadges() {
        Set<String> installed = scanInstalledNormalizedNames();
        for (int i = 0; i < allHits.size(); i++) {
            boolean alreadyInstalled = isInstalled(allHits.get(i), installed);
            ScreenHelper.setButtonLabel(this, installButtons[i], alreadyInstalled ? "§a✔ Installé" : "Installer");
            ScreenHelper.setActive(installButtons[i], !alreadyInstalled);
        }
    }

    /**
     * Place chaque slot [0, ROW_SLOTS[ à sa position Y réelle (RESULTS_Y +
     * (index - scrollOffset) * SPACING) et ne le rend visible que s'il tombe
     * entièrement dans la fenêtre [RESULTS_Y, viewportBottom[. C'est le
     * déplacement réel (pas juste un changement de texte) qui donne l'effet de
     * scroll — un slot qui sort de la fenêtre est caché, pas juste vidé.
     */
    private void repositionSlots() {
        for (int i = 0; i < ROW_SLOTS; i++) {
            Object descBtn = descButtons[i];
            Object installBtn = installButtons[i];
            Object iconWidget = iconWidgets[i];
            boolean hasHit = i < allHits.size();
            int y = RESULTS_Y + (i - scrollOffset) * RESULTS_SPACING;
            boolean inViewport = hasHit && y >= RESULTS_Y && y + RESULTS_HEIGHT <= viewportBottom;
            // Icône visible seulement si le pack en a une ET qu'elle a fini de charger.
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

    /**
     * §f titre en gras, puis auteur/téléchargements en gris clair sur la même
     * ligne — tronqué pour ne jamais dépasser la largeur du bouton (230px,
     * marge incluse). Sans ça le texte déborde visuellement hors du bouton
     * sur les titres longs (vu en jeu : "n x Fresh Animations" au lieu du
     * début du titre, vanilla ne clippe pas le texte d'un Button).
     */
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

    // ── Déjà installé ? (heuristique, sans appel réseau supplémentaire) ─────────
    //
    // On ne connaît le nom de fichier exact d'un pack qu'après avoir appelé
    // getLatestFile() (au moment de l'installation) — faire cet appel pour
    // chaque résultat juste pour l'affichage de la liste coûterait un aller-
    // retour Modrinth par ligne. À la place : normalise les noms de fichiers
    // déjà présents dans le dossier resourcepacks et vérifie si le titre du
    // pack y apparaît comme sous-chaîne. Faux négatifs possibles si le nom de
    // fichier Modrinth ne ressemble pas au titre affiché — acceptable pour un
    // indicateur visuel, pas une garantie d'unicité.
    private Set<String> scanInstalledNormalizedNames() {
        Set<String> names = new HashSet<>();
        try {
            if (java.nio.file.Files.isDirectory(resourcePacksDir)) {
                try (var stream = java.nio.file.Files.list(resourcePacksDir)) {
                    stream.forEach(p -> names.add(normalize(p.getFileName().toString())));
                }
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] scanInstalled: " + e);
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

    // ── Détail ────────────────────────────────────────────────────────────────

    private void openDetail(int slot) {
        if (slot >= allHits.size()) return;
        ModrinthJson.Hit hit = allHits.get(slot);
        ScreenHelper.navigate(this, new ResourcePackDetailScreen(this, hit, resourcePacksDir));
    }

    // ── Installation ───────────────────────────────────────────────────────────

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

            Path dest = resourcePacksDir.resolve(filename);
            boolean ok = ContentBridge.downloadFile(url, dest.toString());

            // Pas besoin de rafraîchir manuellement la liste vanilla : PackScreen
            // surveille son dossier resourcepacks via son propre DirectoryWatcher
            // (voir gwo$a dans les mappings) et détecte le nouveau fichier seul.
            onMc(() -> {
                setStatus(ok
                    ? "§a✔ " + hit.title + " installé §7— visible dans la liste \"Disponibles\""
                    : "§cÉchec du téléchargement de " + hit.title);
                if (ok) refreshInstalledBadges(); // sans reset du scroll (showResults() le ferait)
            });
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent-Screen] doInstall: " + t);
            onMc(() -> setStatus("§cErreur installation : " + t.getMessage()));
        } finally {
            busy = false;
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private void setStatus(String text) {
        ScreenHelper.setButtonLabel(this, statusLabel, text);
        ScreenHelper.setVisible(statusLabel, text != null && !text.isEmpty());
    }

    private void onMc(Runnable task) {
        ScreenHelper.executeOnMc(mc, task);
    }
}
