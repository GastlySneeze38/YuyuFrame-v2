package com.yuyuframe.launcheragent.mixin.service;

import org.spongepowered.asm.service.IGlobalPropertyService;
import org.spongepowered.asm.service.IPropertyKey;

import java.util.HashMap;
import java.util.Map;

public class LauncherGlobalPropertyService implements IGlobalPropertyService {

    private final Map<String, Object> props = new HashMap<>();

    private static class Key implements IPropertyKey {
        final String name;
        Key(String name) { this.name = name; }
        @Override public String toString() { return name; }
    }

    @Override
    public IPropertyKey resolveKey(String name) {
        return new Key(name);
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> T getProperty(IPropertyKey key) {
        return (T) props.get(key.toString());
    }

    @Override
    public void setProperty(IPropertyKey key, Object value) {
        props.put(key.toString(), value);
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> T getProperty(IPropertyKey key, T defaultValue) {
        Object v = props.get(key.toString());
        return v != null ? (T) v : defaultValue;
    }

    @Override
    public String getPropertyString(IPropertyKey key, String defaultValue) {
        Object v = props.get(key.toString());
        return v != null ? v.toString() : defaultValue;
    }
}
