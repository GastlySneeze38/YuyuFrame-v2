package com.yuyuframe.launcheragent.mixin.service;

import org.spongepowered.asm.launch.platform.container.IContainerHandle;

import java.util.Collection;
import java.util.Collections;

/** Conteneur Mixin minimal représentant notre JAR agent. */
public class LauncherContainerHandle implements IContainerHandle {

    private final String id;
    private final String description;

    public LauncherContainerHandle(String id, String description) {
        this.id = id;
        this.description = description;
    }

    @Override public String getId()          { return id; }
    @Override public String getDescription() { return description; }

    @Override
    public String getAttribute(String name) { return null; }

    @Override
    public Collection<IContainerHandle> getNestedContainers() {
        return Collections.emptyList();
    }
}
