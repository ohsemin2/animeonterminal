# animeonterminal

Print anime character portraits in your terminal.

```bash
npm install -g animeonterminal
animeonterminal hitori goto
```

The CLI searches public anime character databases, downloads the selected portrait into a local cache, converts it to outline-style braille terminal art, and prints it without extra metadata by default.

## Local Development

```bash
npm install
npm link
animeonterminal hitori goto
```

You can also run without linking:

```bash
npm start -- hitori goto
```

For local portrait-selection regression checks:

```bash
npm run evaluate -- --refresh
```

This writes a contact sheet of the default character sample set to the temporary directory printed by the command.

## Options

```bash
animeonterminal "Hitori Gotou" --size large
animeonterminal bocchi --provider anilist --width 72
animeonterminal hitori goto --no-color
animeonterminal hitori goto --color
animeonterminal mikasa ackerman --style color-braille
animeonterminal ryo yamada --style braille
animeonterminal mikasa ackerman --style shade
animeonterminal hitori goto --info
animeonterminal hitori goto --source
```

Available providers:

- `auto`: Jikan profile portraits first, then AniList, then ACDB
- `anilist`: AniList GraphQL API
- `jikan`: Jikan REST API for MyAnimeList data
- `acdb`: Anime Characters Database API

## Notes

Images are cached under `~/.cache/animeonterminal`. The package does not bundle anime character images.
