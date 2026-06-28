package com.yuyuframe.launcheragent.mixin.client;

import com.yuyuframe.launcheragent.runtime.fabric.FabricKnotExposer;
import com.yuyuframe.launcheragent.runtime.fabric.ShaderLoaderDetector;
import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.screen.ScreenHelper;
import com.yuyuframe.launcheragent.screen.ShaderPackSearchScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import java.nio.file.Path;

/**
 * Ajoute un bouton "Shaders..." dans le menu pause, qui ouvre la recherche/
 * installation de shader packs Modrinth (voir ShaderPackSearchScreen) — même
 * principe que PackScreenMixin pour les resource packs, voir ce fichier pour
 * le détail des mécanismes réutilisés (réflexion ScreenHelper, refmap, etc.).
 *
 * Bouton affiché uniquement si un loader de shaders compatible (Iris) est
 * détecté — un shaderpack installé sans loader ne fait rien, et son
 * installation silencieuse sans feedback visuel serait trompeuse.
 *
 * @Inject sur "F()V" (initWidgets), pas "bg_()V" (init) : depuis le passage de
 * GameMenuScreen à un layout GridWidget, c'est Screen.init() (inchangé, pas
 * surchargé par GameMenuScreen) qui appelle this.initWidgets() — la vraie
 * méthode où le contenu spécifique à cet écran est construit. Voir
 * LauncherMixinService.REFMAP_ENTRIES pour la traduction official→intermediary
 * de "F()V" sous Fabric.
 */
@Mixin(targets = "net.minecraft.client.gui.screen.GameMenuScreen")
public abstract class GameMenuScreenMixin {

    private static final int BUTTON_WIDTH = 100;
    private static final int BUTTON_HEIGHT = 20;
    private static final int MARGIN = 6;

    @Inject(method = "F()V", at = @At("TAIL"))
    private void la$onInitWidgets(CallbackInfo ci) {
        try {
            FabricKnotExposer.ensureExposed(this.getClass().getClassLoader());

            if (!ShaderLoaderDetector.isPresent(this.getClass().getClassLoader())) return;

            int h = ScreenHelper.getHeight(this);
            // Coin bas-gauche, à l'écart de la grille de boutons centrée de
            // GameMenuScreen — pas de findBottomRow ici (conçu pour une rangée
            // de boutons en bas d'écran comme PackScreen, pas pour un layout en
            // grille centrée où "la rangée la plus basse" serait au milieu).
            ScreenHelper.addButton(this, MARGIN, h - BUTTON_HEIGHT - MARGIN, BUTTON_WIDTH, BUTTON_HEIGHT,
                "Shaders...", this::la$openSearch);
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] GameMenuScreenMixin onInitWidgets: " + t);
        }
    }

    @Unique
    private void la$openSearch() {
        try {
            java.io.File runDir = ScreenHelper.getRunDirectory(this);
            if (runDir == null) {
                LauncherLog.err("[LauncherAgent] GameMenuScreen: runDirectory introuvable");
                return;
            }
            Path shaderPacksDir = runDir.toPath().resolve("shaderpacks");
            ShaderPackSearchScreen screen = new ShaderPackSearchScreen(this, shaderPacksDir);
            ScreenHelper.navigate(this, screen);
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] GameMenuScreen openSearch: " + t);
        }
    }
}
