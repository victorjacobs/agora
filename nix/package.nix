{ lib, buildNpmPackage, nodejs_24, makeWrapper, nix-gitignore, hermesProfile ? null }:

buildNpmPackage {
  pname = "agora";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = nix-gitignore.gitignoreFilterSourcePure lib.cleanSourceFilter ../.gitignore ../.;

  nodejs = nodejs_24;
  npmDepsHash = "sha256-3dNZ6PcSHeKTpTFFiFa+f3tVMkycFPtX3tjukwFJfOQ=";
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
    mkdir -p "$out/share/agora/src/hermes" "$out/share/agora/scripts"
    cp src/hermes/gateway.ts "$out/share/agora/src/hermes/"
    cp scripts/push-vapid.mjs "$out/share/agora/scripts/"
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
