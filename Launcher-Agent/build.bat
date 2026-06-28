@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "AGENT_DIR=%~dp0"
set "SRC_MAIN=%AGENT_DIR%src\main\java"
set "SRC_STUBS=%AGENT_DIR%src\stubs"
set "RES=%AGENT_DIR%src\main\resources"
set "LIB=%AGENT_DIR%lib"
set "OUT_MAIN=%AGENT_DIR%build\main"
set "OUT_STUBS=%AGENT_DIR%build\stubs"
set "OUT_ASM=%AGENT_DIR%build\_asm_tmp"
set "JAR=%AGENT_DIR%build\launcher-agent.jar"
set "VER_TMP=%TEMP%\launcheragent_ver.txt"

echo.
echo  ================================================
echo    YuyuFrame LauncherAgent - Build + Deploy
echo  ================================================
echo.

:: --- Trouver javac.exe et jar.exe automatiquement ----------------------------

set "JAVAC_CMD="
set "JAR_CMD="

if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\javac.exe" (
        set "JAVAC_CMD=%JAVA_HOME%\bin\javac.exe"
        set "JAR_CMD=%JAVA_HOME%\bin\jar.exe"
    )
)

if not defined JAVAC_CMD (
    for %%R in ("C:\Program Files\Java" "C:\Program Files\Eclipse Adoptium" "C:\Program Files\Microsoft" "C:\Program Files\BellSoft" "C:\Program Files\Amazon Corretto") do (
        if not defined JAVAC_CMD (
            for /d %%D in ("%%~R\jdk-*") do (
                if not defined JAVAC_CMD (
                    if exist "%%~D\bin\javac.exe" (
                        set "JAVAC_CMD=%%~D\bin\javac.exe"
                        set "JAR_CMD=%%~D\bin\jar.exe"
                    )
                )
            )
        )
    )
)

if not defined JAVAC_CMD (
    echo [ERREUR] javac.exe introuvable.
    echo  Installe un JDK 17+ et configure JAVA_HOME.
    goto :error
)
echo [Java] %JAVAC_CMD%
echo.

:: --- Incrementer BUILD_VERSION dans LauncherAgent.java -----------------------

echo [Version] Mise a jour de BUILD_VERSION...
powershell -NoProfile -Command "$q=[char]34; $f='%AGENT_DIR%src\main\java\com\yuyuframe\launcheragent\agent\LauncherAgent.java'; $enc=New-Object System.Text.UTF8Encoding $false; $raw=[IO.File]::ReadAllBytes($f); $c=[System.Text.Encoding]::UTF8.GetString($raw); if([int]$c[0] -eq 0xFEFF){$c=$c.Substring(1)}; $pat='BUILD_VERSION\s*=\s*'+$q+'(\d{4}-\d{2}-\d{2})-v(\d+)'+$q; $m=[regex]::Match($c,$pat); if($m.Success){ $old=$m.Groups[2].Value; $new=[int]$old+1; $d=(Get-Date).ToString('yyyy-MM-dd'); $r='BUILD_VERSION = '+$q+$d+'-v'+$new+$q; $c=$c.Replace($m.Value,$r); $sw=New-Object System.IO.StreamWriter($f,$false,$enc); $sw.Write($c); $sw.Close(); Set-Content '%VER_TMP%' ('v'+$old+' vers v'+$new+' ('+$d+')') -Encoding ASCII } else { Set-Content '%VER_TMP%' 'SKIP (pattern non trouve)' -Encoding ASCII }"
set /p VER_MSG=< "%VER_TMP%"
del "%VER_TMP%" 2>nul
echo [Version] %VER_MSG%
echo.

:: --- Telecharger les dependances manquantes ----------------------------------
:: Memes dependances que p2p-agent (Mixin standalone + ASM) mais copie
:: independante dans Launcher-Agent\lib\ — aucun partage de jar entre agents.

if not exist "%LIB%" mkdir "%LIB%"

if not exist "%LIB%\mixin.jar" (
    echo [Deps] Telechargement Mixin 0.8.7...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://repo.spongepowered.org/maven/org/spongepowered/mixin/0.8.7/mixin-0.8.7.jar' -OutFile '%LIB%\mixin.jar' -UseBasicParsing"
    if errorlevel 1 ( echo [ERREUR] Telechargement Mixin echoue & goto :error )
)
if not exist "%LIB%\asm-9.5.jar" (
    echo [Deps] Telechargement ASM 9.5...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://repo1.maven.org/maven2/org/ow2/asm/asm/9.5/asm-9.5.jar' -OutFile '%LIB%\asm-9.5.jar' -UseBasicParsing"
    if errorlevel 1 ( echo [ERREUR] Telechargement ASM echoue & goto :error )
)
if not exist "%LIB%\asm-tree-9.5.jar" (
    echo [Deps] Telechargement ASM-Tree 9.5...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://repo1.maven.org/maven2/org/ow2/asm/asm-tree/9.5/asm-tree-9.5.jar' -OutFile '%LIB%\asm-tree-9.5.jar' -UseBasicParsing"
    if errorlevel 1 ( echo [ERREUR] Telechargement ASM-Tree echoue & goto :error )
)
if not exist "%LIB%\asm-util-9.5.jar" (
    echo [Deps] Telechargement ASM-Util 9.5...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://repo1.maven.org/maven2/org/ow2/asm/asm-util/9.5/asm-util-9.5.jar' -OutFile '%LIB%\asm-util-9.5.jar' -UseBasicParsing"
    if errorlevel 1 ( echo [ERREUR] Telechargement ASM-Util echoue & goto :error )
)
if not exist "%LIB%\asm-analysis-9.5.jar" (
    echo [Deps] Telechargement ASM-Analysis 9.5...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://repo1.maven.org/maven2/org/ow2/asm/asm-analysis/9.5/asm-analysis-9.5.jar' -OutFile '%LIB%\asm-analysis-9.5.jar' -UseBasicParsing"
    if errorlevel 1 ( echo [ERREUR] Telechargement ASM-Analysis echoue & goto :error )
)
if not exist "%LIB%\asm-commons-9.5.jar" (
    echo [Deps] Telechargement ASM-Commons 9.5...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://repo1.maven.org/maven2/org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar' -OutFile '%LIB%\asm-commons-9.5.jar' -UseBasicParsing"
    if errorlevel 1 ( echo [ERREUR] Telechargement ASM-Commons echoue & goto :error )
)

:: --- Compiler les stubs MC (compile-only, non inclus dans le JAR final) ------

if exist "%OUT_STUBS%" rmdir /s /q "%OUT_STUBS%"
mkdir "%OUT_STUBS%"
echo [Stubs] Compilation des stubs Minecraft...

set "STUBLIST=%TEMP%\launcheragent_stubs.txt"
powershell -NoProfile -Command "$q=[char]34; $files=Get-ChildItem -Recurse -Filter '*.java' '%AGENT_DIR%src\stubs' | Select-Object -ExpandProperty FullName | ForEach-Object { $q+$_.Replace('\','/')+$q }; [IO.File]::WriteAllLines('%STUBLIST%', $files)"

"%JAVAC_CMD%" --release 17 -d "%OUT_STUBS%" "@%STUBLIST%"
del "%STUBLIST%" 2>nul
if errorlevel 1 (
    echo [ERREUR] Compilation stubs echouee.
    goto :error
)
echo [Stubs] OK

:: --- Compiler le code principal ----------------------------------------------

if exist "%OUT_MAIN%" rmdir /s /q "%OUT_MAIN%"
mkdir "%OUT_MAIN%"
echo [Build] Compilation principale...

set "SRCLIST=%TEMP%\launcheragent_sources.txt"
powershell -NoProfile -Command "$q=[char]34; $dirs=@('%AGENT_DIR%src\main\java','%AGENT_DIR%src\stubs'); $files=$dirs | ForEach-Object { Get-ChildItem -Recurse -Filter '*.java' $_ } | Select-Object -ExpandProperty FullName | ForEach-Object { $q+$_.Replace('\','/')+$q }; [IO.File]::WriteAllLines('%SRCLIST%', $files)"

"%JAVAC_CMD%" --release 17 ^
  -cp "%LIB%\mixin.jar;%LIB%\asm-9.5.jar;%LIB%\asm-tree-9.5.jar;%OUT_STUBS%" ^
  -d "%OUT_MAIN%" ^
  "@%SRCLIST%"
del "%SRCLIST%" 2>nul
if errorlevel 1 (
    echo [ERREUR] Compilation echouee.
    goto :error
)
echo [Build] Compilation OK

:: --- Copier les ressources (mixins.launcheragent.json + META-INF) ------------

echo [Build] Copie des ressources...
xcopy /s /e /y /q "%RES%\" "%OUT_MAIN%\" >nul
echo [Build] Ressources copiees

:: --- ASM NON embarque dans le JAR (volontaire) --------------------------------
:: launcher-agent.jar reste un JAR "fin" : les classes ASM ne sont jamais copiees
:: dedans. Raison : le jar d'un -javaagent est ajoute par la JVM au classpath du
:: system classloader — si on embarque ASM ET qu'une copie distincte d'ASM est
:: deja sur ce meme classpath (notre propre asm-9.5.jar ajoute par launcher.rs,
:: OU la copie de Fabric Loader quand l'instance utilise Fabric), Fabric Knot
:: detecte des classes ASM dupliquees au demarrage et refuse de lancer
:: ("duplicate ASM classes found on classpath"). Le launcher ajoute toujours
:: asm-9.5.jar/asm-tree-9.5.jar separement au -cp pour le mode vanilla, et les
:: omet quand Fabric est le loader (sa propre copie suffit) — voir launcher.rs.

:: --- Creer le JAR final ------------------------------------------------------

echo [Build] Packaging JAR...
if exist "%JAR%" del "%JAR%"
"%JAR_CMD%" --create --file="%JAR%" ^
    --manifest="%RES%\META-INF\MANIFEST.MF" ^
    -C "%OUT_MAIN%" .
if errorlevel 1 (
    echo [ERREUR] Packaging JAR echoue.
    goto :error
)
for %%F in ("%JAR%") do set /a JAR_KB=%%~zF / 1024
echo [Build] JAR cree : build\launcher-agent.jar (%JAR_KB% Ko)

:: --- Deployer dans AppData\YuyuFrame\agent\ ----------------------------------
:: Sous-dossier dedie, separe de %APPDATA%\YuyuFrame\p2p\ — ne jamais melanger
:: les jars/DLL des deux agents (voir docs/LauncherAgent/index.md).

set "AGENT_DEPLOY_DIR=%APPDATA%\YuyuFrame\agent"
echo [Deploy] Destination : %AGENT_DEPLOY_DIR%
if not exist "%AGENT_DEPLOY_DIR%" mkdir "%AGENT_DEPLOY_DIR%"
copy /Y "%JAR%"                       "%AGENT_DEPLOY_DIR%\launcher-agent.jar"    >nul
copy /Y "%LIB%\mixin.jar"             "%AGENT_DEPLOY_DIR%\mixin.jar"             >nul
copy /Y "%LIB%\asm-9.5.jar"           "%AGENT_DEPLOY_DIR%\asm-9.5.jar"           >nul
copy /Y "%LIB%\asm-tree-9.5.jar"      "%AGENT_DEPLOY_DIR%\asm-tree-9.5.jar"      >nul
copy /Y "%LIB%\asm-util-9.5.jar"      "%AGENT_DEPLOY_DIR%\asm-util-9.5.jar"      >nul
copy /Y "%LIB%\asm-analysis-9.5.jar"  "%AGENT_DEPLOY_DIR%\asm-analysis-9.5.jar"  >nul
copy /Y "%LIB%\asm-commons-9.5.jar"   "%AGENT_DEPLOY_DIR%\asm-commons-9.5.jar"   >nul
if exist "%~dp0content-core\target\release\content_core.dll" (
    copy /Y "%~dp0content-core\target\release\content_core.dll" "%AGENT_DEPLOY_DIR%\content_core.dll" >nul
    echo [Deploy] content_core.dll deploye
) else (
    echo [Deploy] content_core.dll absente ^(non implementee — voir docs/LauncherAgent/index.md^)
)
if errorlevel 1 (
    echo [ERREUR] Deploiement echoue.
    goto :error
)
echo [Deploy] Deploye avec succes

:: --- Resume ------------------------------------------------------------------

echo.
echo  ================================================
echo    Build termine !  Version : %VER_MSG%
echo    %AGENT_DEPLOY_DIR%\launcher-agent.jar
echo  ================================================
echo.
pause
exit /b 0

:error
echo.
echo  [BUILD ECHOUE]
echo.
pause
exit /b 1
