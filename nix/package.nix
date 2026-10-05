{ lib, buildNpmPackage, nodejs_24, makeWrapper, nix-gitignore, hermesProfile ? null }:

buildNpmPackage {
  pname = "agora";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = nix-gitignore.gitignoreFilterSourcePure lib.cleanSourceFilter ../.gitignore ../.;

  nodejs = nodejs_24;
  npmDepsHash = "sha256-AzL5P9vY1v+6tciGOzx2IMKr1Kz84wIE6DBL3lQq2Cg=";
  nativeBuildInputs = [ makeWrapper ];

  env = lib.optionalAttrs (hermesProfile != null) {
    VITE_HERMES_PROFILE = hermesProfile;
  };

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --ignore-scripts --offline
    mkdir -p "$out/share/agora" "$out/bin"
    cp -r dist server node_modules package.json "$out/share/agora/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/agora" \
      --run "cd '$out/share/agora'" \
      --add-flags "$out/share/agora/server/run.ts"

    runHook postInstall
  '';

  meta = {
    description = "Chat client for the Hermes Agent dashboard";
    homepage = "https://github.com/victorjacobs/agora";
    mainProgram = "agora";
    platforms = lib.platforms.unix;
  };
}
