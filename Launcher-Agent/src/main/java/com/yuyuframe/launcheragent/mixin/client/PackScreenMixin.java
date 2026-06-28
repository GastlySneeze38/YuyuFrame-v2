package com.yuyuframe.launcheragent.mixin.client;

import com.yuyuframe.launcheragent.runtime.fabric.FabricKnotExposer;
import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.screen.ScreenHelper;
import com.yuyuframe.launcheragent.screen.ResourcePackSearchScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import java.nio.file.Path;

/**
 * Ajoute un bouton "Modrinth..." sur l'écran vanilla Resource Packs, qui ouvre
 * notre écran de recherche/installation (voir ResourcePackSearchScreen).
 *
 * Décision de conception (voir docs/LauncherAgent/index.md, section "UI") :
 * augmenter l'écran vanilla plutôt que le remplacer entièrement. Reconstruire
 * la liste locale + le système d'activation par réflexion serait fragile sans
 * mappings de champs vérifiés pour chaque version MC ; on délègue cette partie
 * à vanilla et on n'ajoute que la recherche Modrinth, qui n'existe pas du tout
 * côté vanilla. Le fichier téléchargé apparaît automatiquement dans la liste
 * "Disponibles" grâce au DirectoryWatcher déjà présent dans PackScreen.
 */
@Mixin(targets = "net.minecraft.client.gui.screen.pack.PackScreen")
public abstract class PackScreenMixin {

    private static final int BUTTON_WIDTH = 100;
    private static final int BUTTON_GAP = 4;

    @Inject(method = "bg_()V", at = @At("TAIL"))
    private void la$onInit(CallbackInfo ci) {
        FabricKnotExposer.ensureExposed(this.getClass().getClassLoader());
        LauncherLog.ui(1, "[LauncherAgent] PackScreenMixin.la$onInit() appelé");
        try {
            int h = ScreenHelper.getHeight(this);

            // Aligné sur la vraie rangée de boutons vanilla ("Open Pack Folder",
            // "Done") plutôt qu'une position fixe : on lit le Y réellement
            // observé du widget le plus bas (pas une formule devinée comme
            // h-28, qui peut ne pas correspondre à cette version/cet écran) et
            // on se place juste à gauche du plus à gauche, à ce même Y.
            // Fallback bas-gauche si la rangée n'est pas trouvée.
            int[] row = ScreenHelper.findBottomRow(this, h - 28);
            int x, y;
            if (row != null) {
                x = row[0] - BUTTON_GAP - BUTTON_WIDTH;
                y = row[1];
            } else {
                x = 8;
                y = h - 28;
            }
            if (x < 4) x = 4; // évite de sortir de l'écran sur une fenêtre très étroite

            LauncherLog.ui(1, "[LauncherAgent] PackScreenMixin: h=" + h + " row=" + java.util.Arrays.toString(row)
                + " → bouton à (" + x + "," + y + ")");
            Object btn = ScreenHelper.addButton(this, x, y, BUTTON_WIDTH, 20, "Modrinth...", this::la$openSearch);
            LauncherLog.ui(1, "[LauncherAgent] PackScreenMixin: addButton a renvoyé " + btn);
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] PackScreenMixin onInit: " + t);
            t.printStackTrace(System.err);
        }
    }

    @Unique
    private void la$openSearch() {
        try {
            LauncherLog.ui(1, "[LauncherAgent] openSearch: classloader de PackScreen(this)=" + this.getClass().getClassLoader()
                + " | classloader de ResourcePackSearchScreen=" + ResourcePackSearchScreen.class.getClassLoader());
            Path resourcePacksDir = la$getResourcePacksDir();
            if (resourcePacksDir == null) {
                LauncherLog.err("[LauncherAgent] PackScreen.G (resourcePacksDir) introuvable");
                return;
            }
            ResourcePackSearchScreen screen = new ResourcePackSearchScreen(this, resourcePacksDir);
            ScreenHelper.navigate(this, screen);
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] openSearch: " + t);
            t.printStackTrace(System.err);
        }
    }

    /**
     * Lit le champ privé "G" (java.nio.file.Path, nommé "file" côté Yarn) déjà
     * utilisé par PackScreen lui-même pour son propre dossier resourcepacks —
     * pas besoin de recalculer ce chemin côté launcher (voir docs/LauncherAgent
     * /index.md, point laissé ouvert sur instance_resourcepacks_dir()).
     */
    @Unique
    private Path la$getResourcePacksDir() {
        Class<?> c = this.getClass();
        while (c != null && !c.getName().equals("java.lang.Object")) {
            for (java.lang.reflect.Field f : c.getDeclaredFields()) {
                if (f.getType() == Path.class) {
                    try {
                        f.setAccessible(true);
                        Object v = f.get(this);
                        if (v instanceof Path) return (Path) v;
                    } catch (Exception ignored) {}
                }
            }
            c = c.getSuperclass();
        }
        return null;
    }
}
