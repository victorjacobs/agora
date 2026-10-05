{
  description = "Development environment for Agora, a Hermes chat client";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24 git ripgrep
              (writeShellScriptBin "agora-dev" "exec npm run dev -- \"$@\"")
              (writeShellScriptBin "agora-check" "npm run typecheck && npm test && npm run build")
            ];
          };
        });
    };
}
