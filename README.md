# Wayfinder Maps

A small, private map app. A nod to Toronto. FOSS, no account, no analytics, no ads.

## Folder layout

```
index.html
manifest.json
sw.js
small-icon.png        (your small logo, 192x192)
icon.png              (your big emblem with name, 512x512)
assets/
  lib/
    maplibre-gl.js
    maplibre-gl.css
    pmtiles.js
  fonts/              (only needed for labels in Offline mode, see below)
```

Icons are drawn inside index.html, so there is no icon folder.

## Library files (copy once, no CDN)

From the `dist` folder of each npm package, or the GitHub releases:

- `maplibre-gl` (BSD-3): `maplibre-gl.js` and `maplibre-gl.css`
- `pmtiles` (BSD-3): `pmtiles.js` (the browser build that defines a global `pmtiles`)

Put them in `assets/lib/`. Until they are there, the app shows a setup screen.

## Online maps

Default. Vector tiles from OpenFreeMap (free, no key, no account). It sees your IP address and the tiles you view. Nothing else leaves the device.

## Offline maps

Each country or region is one `.pmtiles` file kept in a maps folder on the phone.

1. On a computer, install the free `pmtiles` command-line tool (github.com/protomaps/go-pmtiles).
2. Find the newest build file at maps.protomaps.com/builds.
3. Cut out an area, for example:

```
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles china.pmtiles --bbox=73.5,18.0,134.8,53.6 --maxzoom=14
```

A country at zoom 14 can be large (China is several GB at full detail). Lower `--maxzoom` (for example 10 to 12) for a much smaller file. In the app, Settings, then Offline maps shows a ready-made command for whatever you are currently looking at.

4. Copy the `.pmtiles` file into your maps folder on the phone.
5. In the app: Settings, Offline maps, Choose maps folder. Tick the maps you want. Set Map source to Offline files.

Offline labels need the Protomaps font files in `assets/fonts/` (github.com/protomaps/basemaps-assets, the `fonts` folder). Without them, offline maps draw but show no text. Chinese, Japanese and Korean labels use the phone's own fonts.

## Gestures

- Drag to pan, pinch to zoom, two-finger twist to rotate (compass button resets north)
- Double tap: drop a pin
- Long press: Copy location, Save location, Drop pin, Share, Measure from here

## Search

Type a name and press Enter. Saved places and pasted coordinates are found on the phone. For other place names the app can search online using OpenStreetMap's Nominatim service. It asks the first time, sends only your search text (they also see your IP address), and can be turned On, Off or Ask in Settings. It is switched off in Offline mode.

## Directions

Wayfinder Maps does not calculate routes. Tap Directions on a place, or long-press and choose "Directions to here" (or "Directions from here" to set a start pin first).
- Open in navigation app: hands the destination to an app on your phone, such as OsmAnd or Organic Maps, which routes from where you are. Nothing is sent by Wayfinder Maps.
- Route on openstreetmap.org: opens the OpenStreetMap website in your browser with the start and end points, for car, bike or walking.

## Names

Labels use the names in the map data. Lake Ontario and Gulf of Mexico are kept as those names even if a data source uses another label.

## Data

Saved places, folders, tracks and settings live in the browser or app storage on the device. Export GPX, KML, GeoJSON or a full JSON backup from the Saved sheet.
