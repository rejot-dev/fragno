#!/usr/bin/env bun

import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { Command } from "commander";
import { rgb, oklch, lab, formatHex, differenceEuclidean, type Oklch, type Lab } from "culori";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { basename, extname, join, dirname } from "path";

type PrimaryColorMethod =
  | "most-frequent"
  | "centroid"
  | "median"
  | "most-saturated"
  | "darkest"
  | "lightest"
  | "most-vibrant";

type BucketingStrategy = "kmeans" | "uniform" | "perceptual";

type TailwindPreset = "all" | "warm" | "cool" | "neutral" | "random";

interface ColorInfo {
  hex: string;
  oklch: Oklch;
  lab: Lab;
  frequency: number;
  originalColors: string[];
}

interface ColorBucket {
  colors: ColorInfo[];
  primary: ColorInfo;
  tailwindMatch?: { name: string; hex: string; distance: number };
}

interface SimplificationOptions {
  buckets: number;
  method: PrimaryColorMethod;
  strategy: BucketingStrategy;
  useTailwind: boolean;
  tailwindFamily: string; // Now accepts comma-separated families
  tailwindPreset?: TailwindPreset; // Preset option for special families
  randomCount?: number; // Number of random colors to choose when using random preset
  preserveGradients: boolean;
  mergeSimilar: boolean;
  similarityThreshold: number;
}

interface TailwindColor {
  name: string;
  hex: string;
  oklch: Oklch;
}

class SVGColorSimplifier {
  private tailwindColors: TailwindColor[] = [];
  private xmlParser: XMLParser;
  private xmlBuilder: XMLBuilder;

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      preserveOrder: true,
      processEntities: false,
    });

    this.xmlBuilder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      suppressEmptyNode: true,
      format: true,
      preserveOrder: true,
      processEntities: false,
    });

    this.loadTailwindColors();
  }

  private loadTailwindColors(): void {
    try {
      const cssContent = readFileSync(join(dirname(__filename), "tailwind-colors.css"), "utf-8");
      const colorRegex = /--color-(\w+-\d+):\s*oklch\(([^)]+)\)/g;
      let match;

      while ((match = colorRegex.exec(cssContent)) !== null) {
        const [, name, oklchValues] = match;
        const [l, c, h] = oklchValues.split(" ").map(Number);

        const oklchColor: Oklch = { mode: "oklch", l: l, c: c, h: h || 0 };
        const hexColor = formatHex(oklchColor) || "#000000";

        this.tailwindColors.push({
          name,
          hex: hexColor,
          oklch: oklchColor,
        });
      }

      // Add black and white
      this.tailwindColors.push(
        { name: "black", hex: "#000000", oklch: oklch("#000000") as Oklch },
        { name: "white", hex: "#ffffff", oklch: oklch("#ffffff") as Oklch },
      );

      console.log(`Loaded ${this.tailwindColors.length} Tailwind colors`);
    } catch (error) {
      console.warn("Could not load Tailwind colors:", error);
    }
  }

  private extractColorsFromSVG(svgContent: string): Map<string, number> {
    const colorMap = new Map<string, number>();

    // Color attributes to check
    const colorAttributes = ["fill", "stroke", "stop-color", "flood-color", "lighting-color"];

    // Extract from attributes
    for (const attr of colorAttributes) {
      const regex = new RegExp(`${attr}="([^"]+)"`, "gi");
      let match;
      while ((match = regex.exec(svgContent)) !== null) {
        const color = match[1].trim();
        if (this.isValidColor(color)) {
          colorMap.set(color, (colorMap.get(color) || 0) + 1);
        }
      }
    }

    // Extract from style attributes
    const styleRegex = /style="([^"]+)"/gi;
    let styleMatch;
    while ((styleMatch = styleRegex.exec(svgContent)) !== null) {
      const styleContent = styleMatch[1];

      for (const attr of colorAttributes) {
        const colorRegex = new RegExp(`${attr}:\\s*([^;]+)`, "gi");
        let colorMatch;
        while ((colorMatch = colorRegex.exec(styleContent)) !== null) {
          const color = colorMatch[1].trim();
          if (this.isValidColor(color)) {
            colorMap.set(color, (colorMap.get(color) || 0) + 1);
          }
        }
      }
    }

    return colorMap;
  }

  private isValidColor(colorStr: string): boolean {
    if (
      !colorStr ||
      colorStr === "none" ||
      colorStr === "transparent" ||
      colorStr === "currentColor"
    ) {
      return false;
    }

    try {
      const color = rgb(colorStr);
      return color !== undefined;
    } catch {
      return false;
    }
  }

  private convertColorsToInfo(colorMap: Map<string, number>): ColorInfo[] {
    const colors: ColorInfo[] = [];

    for (const [colorStr, frequency] of colorMap.entries()) {
      try {
        const rgbColor = rgb(colorStr);
        if (!rgbColor) continue;

        const hexColor = formatHex(rgbColor);
        const oklchColor = oklch(rgbColor) as Oklch | undefined;
        const labColor = lab(rgbColor) as Lab | undefined;

        if (!hexColor || !oklchColor || !labColor) continue;

        colors.push({
          hex: hexColor,
          oklch: oklchColor,
          lab: labColor,
          frequency,
          originalColors: [colorStr],
        });
      } catch (error) {
        console.warn(`Failed to convert color ${colorStr}:`, error);
      }
    }

    return colors;
  }

  private mergeSimilarColors(colors: ColorInfo[], threshold: number): ColorInfo[] {
    const merged: ColorInfo[] = [];
    const used = new Set<number>();

    for (let i = 0; i < colors.length; i++) {
      if (used.has(i)) continue;

      const baseColor = colors[i];
      const similar = [baseColor];
      used.add(i);

      for (let j = i + 1; j < colors.length; j++) {
        if (used.has(j)) continue;

        const distance = differenceEuclidean("oklch")(baseColor.oklch, colors[j].oklch);
        if (distance < threshold) {
          similar.push(colors[j]);
          used.add(j);
        }
      }

      // Merge similar colors
      const totalFreq = similar.reduce((sum, c) => sum + c.frequency, 0);
      const avgOklch: Oklch = {
        mode: "oklch",
        l: similar.reduce((sum, c) => sum + c.oklch.l * c.frequency, 0) / totalFreq,
        c: similar.reduce((sum, c) => sum + c.oklch.c * c.frequency, 0) / totalFreq,
        h: this.averageHue(similar.map((c) => ({ h: c.oklch.h || 0, weight: c.frequency }))),
      };

      merged.push({
        hex: formatHex(avgOklch) || baseColor.hex,
        oklch: avgOklch,
        lab: (lab(avgOklch) as Lab) || baseColor.lab,
        frequency: totalFreq,
        originalColors: similar.flatMap((c) => c.originalColors),
      });
    }

    return merged.sort((a, b) => b.frequency - a.frequency);
  }

  private averageHue(hues: { h: number; weight: number }[]): number {
    // Convert hues to unit vectors, average, then convert back
    let x = 0,
      y = 0,
      totalWeight = 0;

    for (const { h, weight } of hues) {
      if (isNaN(h)) continue;
      const rad = (h * Math.PI) / 180;
      x += Math.cos(rad) * weight;
      y += Math.sin(rad) * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return 0;

    const avgRad = Math.atan2(y / totalWeight, x / totalWeight);
    let avgHue = (avgRad * 180) / Math.PI;

    if (avgHue < 0) avgHue += 360;
    return avgHue;
  }

  private createColorBuckets(
    colors: ColorInfo[],
    numBuckets: number,
    strategy: BucketingStrategy,
  ): ColorBucket[] {
    if (colors.length === 0) return [];
    if (numBuckets >= colors.length) {
      return colors.map((color) => ({
        colors: [color],
        primary: color,
      }));
    }

    switch (strategy) {
      case "kmeans":
        return this.kMeansBucketing(colors, numBuckets);
      case "perceptual":
        return this.perceptualBucketing(colors, numBuckets);
      case "uniform":
      default:
        return this.uniformBucketing(colors, numBuckets);
    }
  }

  private uniformBucketing(colors: ColorInfo[], numBuckets: number): ColorBucket[] {
    const sortedColors = [...colors].sort((a, b) => b.frequency - a.frequency);
    const buckets: ColorBucket[] = [];
    const colorsPerBucket = Math.ceil(sortedColors.length / numBuckets);

    for (let i = 0; i < numBuckets && i * colorsPerBucket < sortedColors.length; i++) {
      const bucketColors = sortedColors.slice(i * colorsPerBucket, (i + 1) * colorsPerBucket);
      if (bucketColors.length === 0) break;

      buckets.push({
        colors: bucketColors,
        primary: bucketColors[0], // Will be updated by selectPrimaryColor
      });
    }

    return buckets;
  }

  private kMeansBucketing(colors: ColorInfo[], numBuckets: number): ColorBucket[] {
    // Initialize centroids randomly
    const centroids: Oklch[] = [];
    const usedColors = new Set<number>();

    // Select initial centroids from most frequent colors with some diversity
    for (let i = 0; i < numBuckets; i++) {
      let bestIndex = 0;
      let maxScore = -1;

      for (let j = 0; j < colors.length; j++) {
        if (usedColors.has(j)) continue;

        // Score based on frequency and distance from existing centroids
        let minDistance = Infinity;
        for (const centroid of centroids) {
          const distance = differenceEuclidean("oklch")(colors[j].oklch, centroid);
          minDistance = Math.min(minDistance, distance);
        }

        const frequencyScore =
          colors[j].frequency / colors.reduce((sum, c) => sum + c.frequency, 0);
        const diversityScore = centroids.length === 0 ? 1 : minDistance;
        const score = frequencyScore * 0.3 + diversityScore * 0.7;

        if (score > maxScore) {
          maxScore = score;
          bestIndex = j;
        }
      }

      centroids.push(colors[bestIndex].oklch);
      usedColors.add(bestIndex);
    }

    // K-means iterations
    const maxIterations = 20;
    for (let iter = 0; iter < maxIterations; iter++) {
      const clusters: ColorInfo[][] = Array.from({ length: numBuckets }, () => []);

      // Assign colors to nearest centroid
      for (const color of colors) {
        let nearestIndex = 0;
        let minDistance = Infinity;

        for (let i = 0; i < centroids.length; i++) {
          const distance = differenceEuclidean("oklch")(color.oklch, centroids[i]);
          if (distance < minDistance) {
            minDistance = distance;
            nearestIndex = i;
          }
        }

        clusters[nearestIndex].push(color);
      }

      // Update centroids
      let changed = false;
      for (let i = 0; i < centroids.length; i++) {
        if (clusters[i].length === 0) continue;

        const totalWeight = clusters[i].reduce((sum, c) => sum + c.frequency, 0);
        const newCentroid: Oklch = {
          mode: "oklch",
          l: clusters[i].reduce((sum, c) => sum + c.oklch.l * c.frequency, 0) / totalWeight,
          c: clusters[i].reduce((sum, c) => sum + c.oklch.c * c.frequency, 0) / totalWeight,
          h: this.averageHue(clusters[i].map((c) => ({ h: c.oklch.h || 0, weight: c.frequency }))),
        };

        const distance = differenceEuclidean("oklch")(centroids[i], newCentroid);
        if (distance > 0.01) {
          // Convergence threshold
          changed = true;
          centroids[i] = newCentroid;
        }
      }

      if (!changed) break; // Converged
    }

    // Create final buckets
    const buckets: ColorBucket[] = [];
    for (let i = 0; i < centroids.length; i++) {
      const clusterColors: ColorInfo[] = [];

      for (const color of colors) {
        let nearestIndex = 0;
        let minDistance = Infinity;

        for (let j = 0; j < centroids.length; j++) {
          const distance = differenceEuclidean("oklch")(color.oklch, centroids[j]);
          if (distance < minDistance) {
            minDistance = distance;
            nearestIndex = j;
          }
        }

        if (nearestIndex === i) {
          clusterColors.push(color);
        }
      }

      if (clusterColors.length > 0) {
        buckets.push({
          colors: clusterColors.sort((a, b) => b.frequency - a.frequency),
          primary: clusterColors[0], // Will be updated by selectPrimaryColor
        });
      }
    }

    return buckets.sort(
      (a, b) =>
        b.colors.reduce((sum, c) => sum + c.frequency, 0) -
        a.colors.reduce((sum, c) => sum + c.frequency, 0),
    );
  }

  private perceptualBucketing(colors: ColorInfo[], numBuckets: number): ColorBucket[] {
    // Bucketing based on perceptual similarity in LAB color space
    // First, sort colors by lightness, then group by hue ranges
    const sortedByLightness = [...colors].sort((a, b) => a.lab.l - b.lab.l);

    // Divide into lightness groups first
    const lightnessGroups = Math.min(3, numBuckets); // Light, medium, dark
    const colorsPerLightness = Math.ceil(sortedByLightness.length / lightnessGroups);

    const buckets: ColorBucket[] = [];

    for (let i = 0; i < lightnessGroups; i++) {
      const groupColors = sortedByLightness.slice(
        i * colorsPerLightness,
        Math.min((i + 1) * colorsPerLightness, sortedByLightness.length),
      );

      if (groupColors.length === 0) continue;

      const bucketsForGroup = Math.ceil(numBuckets / lightnessGroups);

      if (groupColors.length <= bucketsForGroup) {
        // If we have fewer colors than buckets, create individual buckets
        for (const color of groupColors) {
          buckets.push({
            colors: [color],
            primary: color,
          });
        }
      } else {
        // Sort by hue and create buckets
        const sortedByHue = groupColors.sort((a, b) => {
          const aHue = a.oklch.h || 0;
          const bHue = b.oklch.h || 0;
          return aHue - bHue;
        });

        const colorsPerBucket = Math.ceil(sortedByHue.length / bucketsForGroup);

        for (let j = 0; j < bucketsForGroup; j++) {
          const bucketColors = sortedByHue.slice(
            j * colorsPerBucket,
            Math.min((j + 1) * colorsPerBucket, sortedByHue.length),
          );

          if (bucketColors.length > 0) {
            buckets.push({
              colors: bucketColors.sort((a, b) => b.frequency - a.frequency),
              primary: bucketColors[0], // Will be updated by selectPrimaryColor
            });
          }
        }
      }
    }

    return buckets
      .slice(0, numBuckets)
      .sort(
        (a, b) =>
          b.colors.reduce((sum, c) => sum + c.frequency, 0) -
          a.colors.reduce((sum, c) => sum + c.frequency, 0),
      );
  }

  private selectPrimaryColor(bucket: ColorBucket, method: PrimaryColorMethod): ColorInfo {
    const { colors } = bucket;
    if (colors.length === 0) throw new Error("Empty bucket");
    if (colors.length === 1) return colors[0];

    switch (method) {
      case "most-frequent":
        return colors.reduce((prev, curr) => (curr.frequency > prev.frequency ? curr : prev));

      case "centroid": {
        const totalFreq = colors.reduce((sum, c) => sum + c.frequency, 0);
        const avgOklch: Oklch = {
          mode: "oklch",
          l: colors.reduce((sum, c) => sum + c.oklch.l * c.frequency, 0) / totalFreq,
          c: colors.reduce((sum, c) => sum + c.oklch.c * c.frequency, 0) / totalFreq,
          h: this.averageHue(colors.map((c) => ({ h: c.oklch.h || 0, weight: c.frequency }))),
        };

        return {
          hex: formatHex(avgOklch) || colors[0].hex,
          oklch: avgOklch,
          lab: (lab(avgOklch) as Lab) || colors[0].lab,
          frequency: totalFreq,
          originalColors: colors.flatMap((c) => c.originalColors),
        };
      }

      case "median": {
        const sorted = [...colors].sort((a, b) => a.oklch.l - b.oklch.l);
        return sorted[Math.floor(sorted.length / 2)];
      }

      case "most-saturated":
        return colors.reduce((prev, curr) => (curr.oklch.c > prev.oklch.c ? curr : prev));

      case "darkest":
        return colors.reduce((prev, curr) => (curr.oklch.l < prev.oklch.l ? curr : prev));

      case "lightest":
        return colors.reduce((prev, curr) => (curr.oklch.l > prev.oklch.l ? curr : prev));

      case "most-vibrant": {
        // Balance of chroma and lightness, avoiding very dark or very light colors
        const vibrancy = (c: ColorInfo) => {
          const l = c.oklch.l;
          const chroma = c.oklch.c;
          const lightnessScore = l > 0.1 && l < 0.9 ? 1 : Math.max(0, 1 - Math.abs(l - 0.5) * 2);
          return chroma * lightnessScore;
        };
        return colors.reduce((prev, curr) => (vibrancy(curr) > vibrancy(prev) ? curr : prev));
      }

      default:
        return colors[0];
    }
  }

  private findNearestTailwindColor(
    color: ColorInfo,
    family: string,
    preset?: TailwindPreset,
    randomCount?: number,
  ): TailwindColor | undefined {
    if (this.tailwindColors.length === 0) return undefined;

    const familyColors = this.filterTailwindColorsByFamily(family, preset, randomCount);
    if (familyColors.length === 0) return undefined;

    let nearest: TailwindColor | undefined;
    let minDistance = Infinity;

    for (const tailwindColor of familyColors) {
      const distance = differenceEuclidean("oklch")(color.oklch, tailwindColor.oklch);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = tailwindColor;
      }
    }

    return nearest;
  }

  private filterTailwindColorsByFamily(
    family: string,
    preset?: TailwindPreset,
    randomCount?: number,
  ): TailwindColor[] {
    // Handle presets first
    if (preset) {
      switch (preset) {
        case "all":
          return this.tailwindColors;
        case "random":
          return this.getRandomTailwindColors(randomCount || 3);
        case "warm":
          return this.filterByFamilyNames(["red", "orange", "amber", "yellow"]);
        case "cool":
          return this.filterByFamilyNames([
            "lime",
            "green",
            "emerald",
            "teal",
            "cyan",
            "sky",
            "blue",
            "indigo",
          ]);
        case "neutral":
          return this.filterByFamilyNames(["slate", "gray", "zinc", "neutral", "stone"]);
      }
    }

    // Handle comma-separated families
    const requestedFamilies = family.split(",").map((f) => f.trim());
    return this.filterByFamilyNames(requestedFamilies);
  }

  private filterByFamilyNames(familyNames: string[]): TailwindColor[] {
    return this.tailwindColors.filter((color) =>
      familyNames.some((f) => color.name.startsWith(f + "-") || color.name === f),
    );
  }

  private getRandomTailwindColors(count: number): TailwindColor[] {
    const shuffled = [...this.tailwindColors].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, this.tailwindColors.length));
  }

  async simplifyColors(svgContent: string, options: SimplificationOptions): Promise<string> {
    console.log("Extracting colors from SVG...");
    const colorMap = this.extractColorsFromSVG(svgContent);
    console.log(`Found ${colorMap.size} unique colors`);

    let colors = this.convertColorsToInfo(colorMap);
    console.log(`Converted ${colors.length} colors to color info`);

    if (options.mergeSimilar) {
      console.log("Merging similar colors...");
      colors = this.mergeSimilarColors(colors, options.similarityThreshold);
      console.log(`After merging: ${colors.length} colors`);
    }

    console.log(`Creating ${options.buckets} color buckets using ${options.strategy} strategy...`);
    const buckets = this.createColorBuckets(colors, options.buckets, options.strategy);

    console.log(`Selecting primary colors using ${options.method} method...`);
    for (const bucket of buckets) {
      bucket.primary = this.selectPrimaryColor(bucket, options.method);

      if (options.useTailwind) {
        const tailwindMatch = this.findNearestTailwindColor(
          bucket.primary,
          options.tailwindFamily,
          options.tailwindPreset,
          options.randomCount,
        );
        if (tailwindMatch) {
          bucket.tailwindMatch = {
            name: tailwindMatch.name,
            hex: tailwindMatch.hex,
            distance: differenceEuclidean("oklch")(bucket.primary.oklch, tailwindMatch.oklch),
          };
        }
      }
    }

    // Create color mapping
    const colorMapping = new Map<string, string>();
    for (const bucket of buckets) {
      const targetColor = bucket.tailwindMatch?.hex || bucket.primary.hex;
      for (const color of bucket.colors) {
        for (const originalColor of color.originalColors) {
          colorMapping.set(originalColor, targetColor);
        }
      }
    }

    console.log(`Applying color mapping to SVG...`);
    let simplifiedSvg = svgContent;
    for (const [original, replacement] of colorMapping.entries()) {
      // Replace in attributes
      const attrRegex = new RegExp(
        `((?:fill|stroke|stop-color|flood-color|lighting-color)=")${this.escapeRegex(original)}(")`,
        "gi",
      );
      simplifiedSvg = simplifiedSvg.replace(attrRegex, `$1${replacement}$2`);

      // Replace in styles
      const styleRegex = new RegExp(
        `((?:fill|stroke|stop-color|flood-color|lighting-color):\\s*)${this.escapeRegex(original)}([;}])`,
        "gi",
      );
      simplifiedSvg = simplifiedSvg.replace(styleRegex, `$1${replacement}$2`);
    }

    return simplifiedSvg;
  }

  private escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async generateVariants(
    svgContent: string,
    outputDir: string,
    baseName: string,
    bucketCounts: number[] = [3, 5, 8, 12, 16, 24],
    methods: PrimaryColorMethod[] = ["most-frequent", "centroid", "most-saturated", "most-vibrant"],
    tailwindOptions: Array<{ use: boolean; family: string; preset?: TailwindPreset }> = [
      { use: false, family: "red" },
      { use: true, family: "red", preset: "all" },
    ],
  ): Promise<void> {
    const variants: Array<{ name: string; options: SimplificationOptions }> = [];

    for (const buckets of bucketCounts) {
      for (const method of methods) {
        for (const { use: useTailwind, family, preset } of tailwindOptions) {
          const presetSuffix = preset ? `-${preset}` : "";
          const suffix = useTailwind
            ? `_${buckets}b_${method}_tw-${family}${presetSuffix}`
            : `_${buckets}b_${method}`;

          variants.push({
            name: `${baseName}${suffix}.svg`,
            options: {
              buckets,
              method,
              strategy: "uniform", // Default strategy for batch generation
              useTailwind,
              tailwindFamily: family,
              tailwindPreset: preset,
              randomCount: preset === "random" ? 10 : undefined,
              preserveGradients: false,
              mergeSimilar: true,
              similarityThreshold: 0.1,
            },
          });
        }
      }
    }

    console.log(`Generating ${variants.length} variants...`);

    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });

    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i];
      console.log(`[${i + 1}/${variants.length}] Generating ${variant.name}...`);

      try {
        const simplified = await this.simplifyColors(svgContent, variant.options);
        const outputPath = join(outputDir, variant.name);
        writeFileSync(outputPath, simplified, "utf-8");
      } catch (error) {
        console.error(`Failed to generate ${variant.name}:`, error);
      }
    }

    console.log(`Generated ${variants.length} variants in ${outputDir}`);
  }

  async generateVariantsAdvanced(
    svgContent: string,
    outputDir: string,
    baseName: string,
    buckets: number,
    tailwindFamily: string,
    tailwindPreset?: TailwindPreset,
    randomCount?: number,
  ): Promise<void> {
    const methods: PrimaryColorMethod[] = [
      "most-frequent",
      "centroid",
      "median",
      "most-saturated",
      "darkest",
      "lightest",
      "most-vibrant",
    ];

    const strategies: BucketingStrategy[] = ["uniform", "kmeans", "perceptual"];
    const mergeSimilarOptions = [true, false];
    const similarityThresholds = [0.05, 0.1, 0.15, 0.2, 0.25];

    const variants: Array<{ name: string; options: SimplificationOptions }> = [];

    for (const method of methods) {
      for (const strategy of strategies) {
        for (const mergeSimilar of mergeSimilarOptions) {
          for (const threshold of similarityThresholds) {
            const presetSuffix = tailwindPreset ? `-${tailwindPreset}` : "";
            const suffix = `_${buckets}b_${method}_${strategy}_${mergeSimilar ? "merged" : "no-merge"}_${threshold.toString().replace(".", "")}_tw-${tailwindFamily}${presetSuffix}`;

            variants.push({
              name: `${baseName}${suffix}.svg`,
              options: {
                buckets,
                method,
                strategy,
                useTailwind: true,
                tailwindFamily,
                tailwindPreset,
                randomCount: tailwindPreset === "random" ? randomCount : undefined,
                preserveGradients: true,
                mergeSimilar,
                similarityThreshold: threshold,
              },
            });
          }
        }
      }
    }

    console.log(`Generating ${variants.length} advanced variants with ${buckets} buckets...`);

    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });

    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i];
      console.log(`[${i + 1}/${variants.length}] Generating ${variant.name}...`);

      try {
        const simplified = await this.simplifyColors(svgContent, variant.options);
        const outputPath = join(outputDir, variant.name);
        writeFileSync(outputPath, simplified, "utf-8");
      } catch (error) {
        console.error(`Failed to generate ${variant.name}:`, error);
      }
    }

    console.log(`Generated ${variants.length} advanced variants in ${outputDir}`);
  }
}

// Main CLI function will be implemented next
async function main(): Promise<void> {
  const program = new Command();

  program
    .name("simplify-svg-colors")
    .description("Simplify colors in SVG files using various bucketing and selection strategies")
    .version("1.0.0");

  program
    .argument("<input>", "Input SVG file path")
    .option("-o, --output <path>", "Output path (file or directory for variants)")
    .option("-b, --buckets <number>", "Number of color buckets", "8")
    .option("-m, --method <method>", "Primary color selection method", "centroid")
    .option("-s, --strategy <strategy>", "Bucketing strategy", "uniform")
    .option("-t, --tailwind", "Clamp colors to nearest Tailwind colors")
    .option(
      "-f, --tailwind-family <family>",
      "Tailwind color family restriction (comma-separated)",
      "red",
    )
    .option(
      "-p, --tailwind-preset <preset>",
      "Tailwind color preset (all, warm, cool, neutral, random)",
    )
    .option("-r, --random-count <count>", "Number of random colors when using random preset", "3")
    .option("--generate-variants", "Generate multiple variants automatically")
    .option(
      "--generate-variants-advanced",
      "Generate comprehensive variants with all methods and strategies",
    )
    .option(
      "--bucket-counts <counts>",
      "Comma-separated bucket counts for variants",
      "3,5,8,12,16,24",
    )
    .option("--preserve-gradients", "Preserve gradient colors")
    .option("--merge-similar", "Merge similar colors before bucketing", true)
    .option("--similarity-threshold <number>", "Threshold for merging similar colors", "0.1")
    .option("--preview", "Generate HTML preview (not implemented yet)")
    .option("--stats", "Output color statistics (not implemented yet)")
    .action(async (input, options) => {
      try {
        const svgContent = readFileSync(input, "utf-8");
        const simplifier = new SVGColorSimplifier();

        if (options.generateVariants) {
          const inputBaseName = basename(input, extname(input));
          const outputDir = options.output || "./output";
          const bucketCounts = options.bucketCounts.split(",").map(Number);

          await simplifier.generateVariants(svgContent, outputDir, inputBaseName, bucketCounts);
        } else if (options.generateVariantsAdvanced) {
          const inputBaseName = basename(input, extname(input));
          const outputDir = options.output || "./advanced-variants";
          const buckets = parseInt(options.buckets);
          const tailwindFamily = options.tailwindFamily as string;
          const tailwindPreset = options.tailwindPreset as TailwindPreset | undefined;
          const randomCount = options.randomCount ? parseInt(options.randomCount) : undefined;

          await simplifier.generateVariantsAdvanced(
            svgContent,
            outputDir,
            inputBaseName,
            buckets,
            tailwindFamily,
            tailwindPreset,
            randomCount,
          );
        } else {
          const simplificationOptions: SimplificationOptions = {
            buckets: parseInt(options.buckets),
            method: options.method as PrimaryColorMethod,
            strategy: options.strategy as BucketingStrategy,
            useTailwind: options.tailwind || false,
            tailwindFamily: options.tailwindFamily as string,
            tailwindPreset: options.tailwindPreset as TailwindPreset | undefined,
            randomCount: options.randomCount ? parseInt(options.randomCount) : undefined,
            preserveGradients: options.preserveGradients || false,
            mergeSimilar: options.mergeSimilar,
            similarityThreshold: parseFloat(options.similarityThreshold),
          };

          const simplified = await simplifier.simplifyColors(svgContent, simplificationOptions);

          if (options.output) {
            writeFileSync(options.output, simplified, "utf-8");
            console.log(`Simplified SVG written to ${options.output}`);
          } else {
            console.log(simplified);
          }
        }
      } catch (error) {
        console.error("Error:", error);
        process.exit(1);
      }
    });

  program.parse();
}

if (import.meta.main) {
  main().catch(console.error);
}
