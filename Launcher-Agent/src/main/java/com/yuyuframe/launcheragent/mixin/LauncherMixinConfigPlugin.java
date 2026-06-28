package com.yuyuframe.launcheragent.mixin;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import org.spongepowered.asm.mixin.extensibility.IMixinConfigPlugin;
import org.spongepowered.asm.mixin.extensibility.IMixinInfo;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.List;
import java.util.Properties;
import java.util.Set;

/**
 * Plugin Mixin — lit launcher-agent.properties (externe puis embarqué) et
 * configure LauncherLog + les options de debug du framework Mixin.
 *
 * Copie indépendante de com.p2pminecraft.mixin.P2PMixinConfigPlugin — propre
 * fichier de config, propre sous-dossier %APPDATA%.
 */
public class LauncherMixinConfigPlugin implements IMixinConfigPlugin {

    private static final String PROPS_FILENAME = "launcher-agent.properties";
    private static final String PROPS_EXTERN_PATH =
        System.getenv("APPDATA") != null
            ? System.getenv("APPDATA") + "\\YuyuFrame\\agent\\" + PROPS_FILENAME
            : null;

    private Properties cfg = new Properties();

    @Override
    public void onLoad(String mixinPackage) {
        cfg = loadProperties();
        applyMixinDebugProperties();
        LauncherLog.loadConfig(cfg);
        LauncherLog.asm(1, "[MixinPlugin] onLoad — package=" + mixinPackage);
    }

    @Override
    public String getRefMapperConfig() {
        return null;
    }

    @Override
    public boolean shouldApplyMixin(String targetClassName, String mixinClassName) {
        String simpleName = mixinClassName.substring(mixinClassName.lastIndexOf('.') + 1);
        if ("true".equalsIgnoreCase(cfg.getProperty("disable_mixin." + simpleName))) {
            LauncherLog.asm(3, "[MixinPlugin] désactivé par config : " + simpleName);
            return false;
        }
        return true;
    }

    @Override
    public void acceptTargets(Set<String> myTargets, Set<String> otherTargets) {}

    @Override
    public List<String> getMixins() {
        return null;
    }

    @Override
    public void preApply(String targetClassName, org.objectweb.asm.tree.ClassNode targetClass,
                         String mixinClassName, IMixinInfo mixinInfo) {}

    @Override
    public void postApply(String targetClassName, org.objectweb.asm.tree.ClassNode targetClass,
                          String mixinClassName, IMixinInfo mixinInfo) {
        LauncherLog.asm(1, "[MixinPlugin] appliqué : " + mixinClassName + " → " + targetClassName);
    }

    private Properties loadProperties() {
        Properties props = new Properties();

        try (InputStream is = getClass().getClassLoader().getResourceAsStream(PROPS_FILENAME)) {
            if (is != null) {
                props.load(is);
                LauncherLog.asm(1, "[MixinPlugin] config chargée depuis JAR : " + PROPS_FILENAME);
            }
        } catch (Exception e) {
            LauncherLog.warn("[MixinPlugin] JAR props non chargées : " + e.getMessage());
        }

        if (PROPS_EXTERN_PATH != null) {
            File external = new File(PROPS_EXTERN_PATH);
            if (external.exists()) {
                try (FileInputStream fis = new FileInputStream(external)) {
                    props.load(fis);
                    LauncherLog.asm(3, "[MixinPlugin] config externe chargée : " + external.getAbsolutePath());
                } catch (Exception e) {
                    LauncherLog.warn("[MixinPlugin] config externe non chargée : " + e.getMessage());
                }
            }
        }

        return props;
    }

    private void applyMixinDebugProperties() {
        applyIfTrue("mixin.debug.export",   "mixin.debug.export");
        applyIfTrue("mixin.debug.verify",   "mixin.debug.verify");
        applyIfTrue("mixin.debug.verbose",  "mixin.debug.verbose");
        applyIfTrue("mixin.debug.strict",   "mixin.debug.strict");
        applyIfTrue("mixin.debug.profiler", "mixin.debug.profiler");
        applyIfTrue("mixin.dump_on_failure", "mixin.dumpTargetOnFailure");
    }

    private void applyIfTrue(String propKey, String sysProp) {
        String val = cfg.getProperty(propKey, "false");
        if ("true".equalsIgnoreCase(val)) {
            System.setProperty(sysProp, "true");
            LauncherLog.asm(1, "[MixinPlugin] " + sysProp + "=true");
        }
    }
}
