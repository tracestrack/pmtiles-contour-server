# PMTiles Contour Server

A Node.js Express server that generates contour vector tiles (MVT) from DEM (Digital Elevation Model) PMTiles files.

## Features

- Reads DEM data from local PMTiles files
- Supports multiple image formats: PNG, WebP, JPEG (using Sharp)
- Generates contour lines using the marching squares algorithm (d3-contour)
- Serves contours as Mapbox Vector Tiles (MVT)
- Supports both Terrarium and Mapbox RGB elevation encoding
- Configurable contour intervals
- CORS enabled for cross-origin requests

## Installation

```bash
npm install
```

## Usage

### Basic Usage

```bash
node server.js <path-to-pmtiles-file>
```

Example:
```bash
node server.js ./terrain-rgb.pmtiles
```

### Environment Variables

Configure the server behavior with these environment variables:

- `PORT` - Server port (default: 3000)
- `ENCODING` - DEM encoding format: `terrarium` or `mapbox` (default: `terrarium`)
- `CONTOUR_INTERVAL` - Contour line interval in meters (default: 10)
- `MAJOR_INTERVAL` - Major contour line interval in meters (default: 50)

Example:
```bash
PORT=8080 ENCODING=mapbox CONTOUR_INTERVAL=20 node server.js ./terrain.pmtiles
```

### Testing

A smoke test is included to verify the TileJSON endpoint is working correctly.

1. Start the server:
```bash
PORT=8099 CONTOUR_INTERVAL=20 node server.js /home/clear/dev/whitebox/maps/mapdata/dtm_global.pmtiles
```

2. Run the test (in a separate terminal):
```bash
npm test
```

Or run directly:
```bash
node test-tilejson.js
```

The test will verify:
- **TileJSON endpoint**: accessibility, valid JSON, required fields, vector layers configuration
- **MVT tile endpoint**: tile generation, CORS headers, response format

**Customize test URLs:**
```bash
TILEJSON_URL=http://localhost:3000/tilejson.json TILE_URL=http://localhost:3000/5/15/10.mvt npm test
```

The MVT test uses tile coordinate 0/0/0 by default, but you can specify a different tile using the `TILE_URL` environment variable.

## API Endpoints

### GET /tilejson.json

Returns TileJSON metadata describing the tileset.

**Response:**
```json
{
  "tilejson": "3.0.0",
  "name": "Contour Lines",
  "description": "Contour lines generated from DEM data",
  "tiles": ["http://localhost:3000/{z}/{x}/{y}.mvt"],
  "minzoom": 0,
  "maxzoom": 14,
  "bounds": [-180, -85.0511, 180, 85.0511],
  "center": [0, 0, 7],
  "vector_layers": [
    {
      "id": "contours",
      "description": "Elevation contour lines",
      "fields": {
        "ele": "Number - Elevation in meters",
        "level": "Number - 0 for minor contours, 1 for major contours"
      }
    }
  ]
}
```

### GET /:z/:x/:y.mvt

Retrieves a contour vector tile for the specified coordinates.

**Parameters:**
- `z` - Zoom level
- `x` - Tile X coordinate
- `y` - Tile Y coordinate

**Response:**
- Content-Type: `application/x-protobuf`
- Returns MVT (Mapbox Vector Tile) with a single layer named `contours`

**Contour Properties:**
- `ele` - Elevation in meters
- `level` - Contour level (0 for minor, 1 for major)

**Example:**
```
http://localhost:3000/12/2048/2048.mvt
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "pmtiles": "/path/to/file.pmtiles"
}
```

## DEM Encoding Formats

### Terrarium

Formula: `(R * 256 + G + B / 256) - 32768`

Used by:
- AWS Terrain Tiles
- Mapzen Terrarium

### Mapbox RGB

Formula: `-10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)`

Used by:
- Mapbox Terrain-RGB v1

## Using with MapLibre GL JS

### Option 1: Using TileJSON (Recommended)

```javascript
// Add source using TileJSON endpoint
map.addSource('contours', {
  type: 'vector',
  url: 'http://localhost:3000/tilejson.json'
});

// Add contour line layer
map.addLayer({
  id: 'contour-lines',
  type: 'line',
  source: 'contours',
  'source-layer': 'contours',
  paint: {
    'line-color': '#877b59',
    'line-width': ['case', ['==', ['get', 'level'], 1], 1.5, 0.5]
  }
});

// Add elevation labels for major contours
map.addLayer({
  id: 'contour-labels',
  type: 'symbol',
  source: 'contours',
  'source-layer': 'contours',
  filter: ['==', ['get', 'level'], 1],
  layout: {
    'symbol-placement': 'line',
    'text-field': ['concat', ['get', 'ele'], 'm'],
    'text-size': 10
  },
  paint: {
    'text-color': '#877b59'
  }
});
```

### Option 2: Using Direct Tile URLs

```javascript
// Add source with direct tile URLs
map.addSource('contours', {
  type: 'vector',
  tiles: ['http://localhost:3000/{z}/{x}/{y}.mvt'],
  minzoom: 0,
  maxzoom: 14
});

// Add layers (same as Option 1)
map.addLayer({
  id: 'contour-lines',
  type: 'line',
  source: 'contours',
  'source-layer': 'contours',
  paint: {
    'line-color': '#877b59',
    'line-width': ['case', ['==', ['get', 'level'], 1], 1.5, 0.5]
  }
});
```

## Performance Considerations

- Contour generation is CPU-intensive. Consider caching generated tiles.
- Lower contour intervals (e.g., 5m) generate more lines and increase processing time.
- For production use, consider:
  - Adding tile caching (Redis, file system)
  - Running multiple server instances behind a load balancer
  - Pre-generating tiles for frequently accessed areas

## Dependencies

- `express` - Web server framework
- `pmtiles` - PMTiles reader
- `d3-contour` - Contour generation (marching squares algorithm)
- `vt-pbf` - Vector tile encoding
- `sharp` - High-performance image decoding (PNG, WebP, JPEG, etc.)

## References

- [maplibre-contour](https://github.com/onthegomap/maplibre-contour) - MapLibre GL JS contour plugin
- [contour-generator](https://github.com/acalcutt/contour-generator) - CLI tool for generating contour tiles
- [PMTiles Specification](https://github.com/protomaps/PMTiles)
- [Mapbox Vector Tile Specification](https://github.com/mapbox/vector-tile-spec)

## License

MIT
