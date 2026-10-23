#!/usr/bin/env bash
# Prepara una release: versione, tag e note.
# Uso: prossima-versione.sh <prefisso tag> <versione base> <percorsi...>
#
# Con VERSIONE impostata (avvio manuale o tag spinto) usa quella. Altrimenti:
# la versione base se è più alta dell'ultima uscita (per una minore o una
# maggiore si alza la base), se no la patch successiva (1.1.0 → 1.1.1 → …).
# In automatico non pubblica se dall'ultima release non è cambiato niente
# nei percorsi. Le note sono docs/note-di-versione/<tag>.md se c'è, se no
# l'elenco delle modifiche ai percorsi seguito da NOTE_EXTRA.
# Scrive V, TAG e PUBBLICA (si/no) in $GITHUB_ENV, le note in $RUNNER_TEMP/note.md.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pre="$1"; base="$2"; shift 2
git fetch -q --tags --force origin

ultimo() { git tag -l "$pre[0-9]*" --sort=-v:refname | grep -vxF "${1:-}" | head -1 || true; }

pubblica=si
if [ -n "${VERSIONE:-}" ]; then
  V="${VERSIONE#"$pre"}"; tag="$pre$V"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null &&
     [ "$(git rev-list -n1 "$tag")" != "$(git rev-parse HEAD)" ]; then
    echo "::error::Il tag $tag esiste già su un altro commit"; exit 1
  fi
  prec=$(ultimo "$tag")
else
  prec=$(ultimo)
  u="${prec#"$pre"}"
  if [ -z "$prec" ] || [ "$(printf '%s\n%s\n' "$base" "$u" | sort -V | tail -1)" != "$u" ]; then
    V="$base"
  else
    IFS=. read -r a b c <<<"$u"; V="$a.$b.$((${c:-0} + 1))"
  fi
  tag="$pre$V"
  if [ -n "$prec" ] && git diff --quiet "$prec" HEAD -- "$@"; then
    pubblica=no
    echo "Nessuna modifica da $prec: niente release."
  fi
fi

note="${RUNNER_TEMP:-/tmp}/note.md"
if [ -f "docs/note-di-versione/$tag.md" ]; then
  cp "docs/note-di-versione/$tag.md" "$note"
else
  {
    echo "## Modifiche"
    git log --first-parent -n 40 --format=%H "${prec:+$prec..}HEAD" -- "$@" | while read -r h; do
      if [ "$(git rev-list --parents -n1 "$h" | wc -w)" -gt 2 ]; then
        t=$(git log -1 --format=%b "$h" | awk 'NF { print; exit }')
        n=$(git log -1 --format=%s "$h" | grep -oE '#[0-9]+' || true)
        echo "- ${t:-$(git log -1 --format=%s "$h")}${n:+ ($n)}"
      else
        echo "- $(git log -1 --format=%s "$h")"
      fi
    done
    if [ -n "${NOTE_EXTRA:-}" ]; then printf '\n%s\n' "$NOTE_EXTRA"; fi
  } >"$note"
fi

echo "Versione $V (tag $tag, precedente ${prec:-nessuno}, pubblica: $pubblica)"
cat "$note"
{ echo "V=$V"; echo "TAG=$tag"; echo "PUBBLICA=$pubblica"; } >>"${GITHUB_ENV:-/dev/null}"
