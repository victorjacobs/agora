#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
mkdir -p public

for size in 16 32 48 192; do
  magick docs/branding/icon.png -filter Lanczos -resize "${size}x${size}" -strip "public/favicon-${size}.png"
done

magick public/favicon-16.png public/favicon-32.png public/favicon-48.png public/favicon.ico
magick docs/branding/icon.png -filter Lanczos -resize 180x180 -background '#415b3a' -alpha remove -alpha off -strip public/apple-touch-icon.png
