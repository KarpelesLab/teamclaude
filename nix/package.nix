{
  lib,
  stdenvNoCC,
  nodejs_24,
  makeWrapper,
}:

let
  packageJson = lib.importJSON ../package.json;
in
stdenvNoCC.mkDerivation {
  pname = "teamclaude";
  version = packageJson.version;

  src = lib.cleanSource ../.;

  nativeBuildInputs = [ makeWrapper ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/share/teamclaude
    cp -R package.json src LICENSE README.md config.example.json $out/share/teamclaude/
    chmod +x $out/share/teamclaude/src/index.js

    makeWrapper ${lib.getExe nodejs_24} $out/bin/teamclaude \
      --add-flags "$out/share/teamclaude/src/index.js" \
      --set-default TEAMCLAUDE_DISABLE_AUTOUPDATE 1

    runHook postInstall
  '';

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    license = lib.licenses.mit;
    mainProgram = "teamclaude";
    platforms = nodejs_24.meta.platforms;
  };
}
