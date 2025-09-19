# SVG Color Simplification Script

A TypeScript script that simplifies colors in SVG files using various bucketing and selection
strategies, with optional Tailwind CSS color mapping.

## Features

- **Multiple Bucketing Strategies**: K-means clustering, uniform distribution, and perceptual
  grouping
- **Primary Color Selection Methods**: Most frequent, centroid, median, most saturated, darkest,
  lightest, most vibrant
- **Tailwind Color Mapping**: Optional clamping to nearest Tailwind CSS colors with family filtering
- **Batch Variant Generation**: Automatically generate dozens of variations with different
  parameters
- **Color Similarity Merging**: Merge very similar colors before processing

## Installation

```bash
cd scripts
bun install
```

## Usage

### Single Simplification

```bash
# Basic usage with 8 color buckets using centroid method
bun simplify-svg-colors.ts input.svg -o output.svg

# Advanced usage with specific parameters
bun simplify-svg-colors.ts input.svg -o output.svg -b 6 -m most-vibrant -s kmeans -t -f cool
```

### Batch Variant Generation

```bash
# Generate all default variants (48 files)
bun simplify-svg-colors.ts input.svg --generate-variants -o ./output/

# Generate variants with custom bucket counts
bun simplify-svg-colors.ts input.svg --generate-variants --bucket-counts 4,8,16 -o ./variants/
```

## Options

### Basic Options

- `-o, --output <path>` - Output file path or directory for variants
- `-b, --buckets <number>` - Number of color buckets (default: 8)
- `-m, --method <method>` - Primary color selection method (default: centroid)
- `-s, --strategy <strategy>` - Bucketing strategy (default: uniform)

### Primary Color Selection Methods

- `most-frequent` - Most common color in each bucket
- `centroid` - Mathematical average of colors in bucket
- `median` - Median color value
- `most-saturated` - Highest chroma value
- `darkest` - Lowest lightness
- `lightest` - Highest lightness
- `most-vibrant` - Balance of saturation and lightness

### Bucketing Strategies

- `uniform` - Simple frequency-based grouping
- `kmeans` - K-means clustering in OKLCH color space
- `perceptual` - Perceptual similarity grouping by lightness and hue

### Tailwind Color Options

- `-t, --tailwind` - Enable Tailwind color mapping
- `-f, --tailwind-family <family>` - Color family restriction (default: all)
  - Options: `all`, `warm`, `cool`, `neutral`, or specific colors like `red`, `blue`, etc.

### Advanced Options

- `--generate-variants` - Generate multiple variants automatically
- `--bucket-counts <counts>` - Comma-separated bucket counts for variants
- `--merge-similar` - Merge similar colors before bucketing (default: true)
- `--similarity-threshold <number>` - Threshold for merging (default: 0.1)
- `--preserve-gradients` - Preserve gradient colors (not fully implemented)

## Examples

### Basic Color Simplification

```bash
# Reduce to 5 colors using most frequent method
bun simplify-svg-colors.ts logo.svg -o logo-simple.svg -b 5 -m most-frequent

# Use k-means clustering with vibrant color selection
bun simplify-svg-colors.ts icon.svg -o icon-clustered.svg -b 8 -s kmeans -m most-vibrant
```

### Tailwind Color Mapping

```bash
# Map colors to warm Tailwind palette
bun simplify-svg-colors.ts illustration.svg -o illustration-warm.svg -t -f warm

# Map to specific blue family with 4 buckets
bun simplify-svg-colors.ts chart.svg -o chart-blue.svg -b 4 -t -f blue
```

### Batch Processing

```bash
# Generate comprehensive variants for design exploration
bun simplify-svg-colors.ts artwork.svg --generate-variants -o ./artwork-variants/

# Generate variants with specific configurations
bun simplify-svg-colors.ts logo.svg --generate-variants --bucket-counts 3,6,12 -o ./logo-options/
```

## Output

### Single File Output

When processing a single file, the script outputs:

- Processing statistics (colors found, merged, etc.)
- Color mapping information
- Simplified SVG file

### Variant Generation Output

When using `--generate-variants`, the script creates multiple files with naming pattern:

- `[basename]_[buckets]b_[method].svg` - Without Tailwind
- `[basename]_[buckets]b_[method]_tw-[family].svg` - With Tailwind

For example:

- `logo_8b_centroid.svg`
- `logo_8b_centroid_tw-all.svg`
- `logo_12b_most-vibrant_tw-cool.svg`

## Color Spaces

The script uses perceptually uniform color spaces for accurate color processing:

- **OKLCH** for Tailwind color matching and primary calculations
- **LAB** for perceptual bucketing
- **RGB** for input/output and display

## Implementation Details

- **Color Extraction**: Parses SVG attributes (`fill`, `stroke`, `stop-color`, etc.) and inline
  styles
- **Similarity Merging**: Uses OKLCH color space distance to merge similar colors before bucketing
- **K-means Clustering**: Implements weighted k-means in OKLCH space with frequency-based
  initialization
- **Tailwind Mapping**: Uses OKLCH distance to find perceptually nearest Tailwind colors
- **Hue Averaging**: Proper circular averaging for hue values in color space

## Limitations

- Gradient color preservation is not fully implemented
- Pattern fills are not processed
- Some complex SVG features may not be handled
- Performance scales with number of colors and complexity

## Dependencies

- `fast-xml-parser` - SVG parsing
- `culori` - Color space conversions and calculations
- `commander` - CLI argument parsing
