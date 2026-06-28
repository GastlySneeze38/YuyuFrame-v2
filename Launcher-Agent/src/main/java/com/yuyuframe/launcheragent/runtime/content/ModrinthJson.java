package com.yuyuframe.launcheragent.runtime.content;

import java.util.ArrayList;
import java.util.List;

/**
 * Extraction JSON minimaliste pour les réponses Modrinth — même style que
 * {@code LauncherAgent.jsonString()} déjà utilisé pour mixins.launcheragent.json.
 * Pas de dépendance à une lib JSON : les champs attendus sont des chaînes
 * simples (pas de tableaux/objets imbriqués à extraire côté Java, content-core
 * fait déjà le travail lourd côté Rust pour getLatestFile()).
 */
public final class ModrinthJson {

    private ModrinthJson() {}

    public static final class Hit {
        public final String title;
        public final String projectId;
        public final String author;
        public final long downloads;
        public final String description;
        public final String iconUrl;

        public Hit(String title, String projectId, String author, long downloads,
                    String description, String iconUrl) {
            this.title = title;
            this.projectId = projectId;
            this.author = author;
            this.downloads = downloads;
            this.description = description;
            this.iconUrl = iconUrl;
        }
    }

    /** Extrait jusqu'à {@code maxResults} entrées de {@code "hits": [...]}. */
    public static List<Hit> parseHits(String json, int maxResults) {
        List<Hit> hits = new ArrayList<>();
        if (json == null) return hits;

        int hitsIdx = json.indexOf("\"hits\"");
        if (hitsIdx < 0) return hits;
        int arrStart = json.indexOf('[', hitsIdx);
        if (arrStart < 0) return hits;
        int arrEnd = matchingBracket(json, arrStart, '[', ']');
        if (arrEnd < 0) return hits;

        int pos = arrStart + 1;
        while (pos < arrEnd && hits.size() < maxResults) {
            int objStart = json.indexOf('{', pos);
            if (objStart < 0 || objStart >= arrEnd) break;
            int objEnd = matchingBracket(json, objStart, '{', '}');
            if (objEnd < 0) break;

            String obj = json.substring(objStart, objEnd + 1);
            String title = jsonString(obj, "title");
            String projectId = jsonString(obj, "project_id");
            String author = jsonString(obj, "author");
            long downloads = jsonLong(obj, "downloads");
            String description = jsonString(obj, "description");
            String iconUrl = jsonString(obj, "icon_url");
            if (title != null && projectId != null) {
                hits.add(new Hit(title, projectId, author, downloads, description, iconUrl));
            }
            pos = objEnd + 1;
        }
        return hits;
    }

    /** Extrait une valeur chaîne simple {@code "key":"value"} (pas d'échappement complexe). */
    public static String jsonString(String json, String key) {
        if (json == null) return null;
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return null;
        i = json.indexOf('"', json.indexOf(':', i) + 1);
        if (i < 0) return null;
        int end = i + 1;
        StringBuilder sb = new StringBuilder();
        while (end < json.length() && json.charAt(end) != '"') {
            char c = json.charAt(end);
            if (c == '\\' && end + 1 < json.length()) {
                sb.append(json.charAt(end + 1));
                end += 2;
            } else {
                sb.append(c);
                end++;
            }
        }
        return sb.toString();
    }

    /** Extrait une valeur numérique simple {@code "key":1234} (pas de guillemets). */
    public static long jsonLong(String json, String key) {
        if (json == null) return 0L;
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return 0L;
        i = json.indexOf(':', i) + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        int end = i;
        while (end < json.length() && (Character.isDigit(json.charAt(end)) || json.charAt(end) == '-')) end++;
        if (end == i) return 0L;
        try { return Long.parseLong(json.substring(i, end)); }
        catch (NumberFormatException e) { return 0L; }
    }

    /** Index du caractère fermant correspondant à {@code open} à la position {@code openPos}. */
    private static int matchingBracket(String s, int openPos, char open, char close) {
        int depth = 0;
        boolean inString = false;
        for (int i = openPos; i < s.length(); i++) {
            char c = s.charAt(i);
            if (inString) {
                if (c == '\\') { i++; }
                else if (c == '"') { inString = false; }
                continue;
            }
            if (c == '"') { inString = true; continue; }
            if (c == open) depth++;
            else if (c == close) {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }
}
