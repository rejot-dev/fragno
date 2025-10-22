#!/usr/bin/env bun

import { Command } from "commander";
import { readdirSync, writeFileSync, statSync } from "fs";
import { join, basename, extname, relative, dirname } from "path";

interface GalleryOptions {
  columns: number;
  title: string;
  outputFile: string;
  sortBy: "name" | "date" | "size";
  showFilenames: boolean;
  originalImage?: string;
}

class HTMLGalleryGenerator {
  private supportedExtensions = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

  generateGallery(inputDir: string, options: GalleryOptions): void {
    console.log(`Scanning directory: ${inputDir}`);

    const imageFiles = this.findImages(inputDir);
    console.log(`Found ${imageFiles.length} images`);

    if (imageFiles.length === 0) {
      console.log("No images found in the directory");
      return;
    }

    const sortedFiles = this.sortFiles(imageFiles, options.sortBy);
    const html = this.generateHTML(sortedFiles, options);

    writeFileSync(options.outputFile, html, "utf-8");
    console.log(`Gallery generated: ${options.outputFile}`);
  }

  private findImages(dir: string): string[] {
    const files: string[] = [];

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (this.supportedExtensions.has(ext)) {
            files.push(join(dir, entry.name));
          }
        }
      }
    } catch (error) {
      console.error(`Error reading directory: ${error}`);
    }

    return files;
  }

  private sortFiles(files: string[], sortBy: "name" | "date" | "size"): string[] {
    return files.sort((a, b) => {
      switch (sortBy) {
        case "name":
          return basename(a).localeCompare(basename(b));
        case "date": {
          const statsA = statSync(a);
          const statsB = statSync(b);
          return statsB.mtime.getTime() - statsA.mtime.getTime(); // Newest first
        }
        case "size": {
          const sizeA = statSync(a).size;
          const sizeB = statSync(b).size;
          return sizeB - sizeA; // Largest first
        }
        default:
          return 0;
      }
    });
  }

  private generateHTML(files: string[], options: GalleryOptions): string {
    const { columns, title, showFilenames, outputFile, originalImage } = options;

    // Generate original image grid item if provided
    let originalImageItem = "";
    if (originalImage) {
      const outputDir = dirname(outputFile);
      const originalImagePath = relative(outputDir, originalImage);
      const originalImageName = basename(originalImage, extname(originalImage));
      originalImageItem = `
        <div class="gallery-item original-image-item">
          <div class="image-container">
            <img src="${originalImagePath}" alt="${originalImageName}" loading="lazy" />
            <div class="original-badge">Original</div>
          </div>
          ${
            showFilenames
              ? `
          <div class="image-info">
            <div class="filename" title="${originalImageName}">${originalImageName}</div>
          </div>
          `
              : ""
          }
        </div>`;
    }

    // Generate image items
    const imageItems = files
      .map((file) => {
        const outputDir = dirname(outputFile);
        const relativePath = relative(outputDir, file);
        const filename = basename(file, extname(file));
        const stats = statSync(file);
        const fileSize = this.formatFileSize(stats.size);
        const modifiedDate = stats.mtime.toLocaleDateString();

        return `
        <div class="gallery-item">
          <div class="image-container">
            <img src="${relativePath}" alt="${filename}" loading="lazy" />
          </div>
          ${
            showFilenames
              ? `
          <div class="image-info">
            <div class="filename" title="${filename}">${filename}</div>
            <div class="metadata">
              <span class="file-size">${fileSize}</span>
              <span class="separator">•</span>
              <span class="date">${modifiedDate}</span>
            </div>
          </div>
          `
              : ""
          }
        </div>`;
      })
      .join("\n");

    // Combine original image item with regular items
    const allImageItems =
      originalImageItem + (originalImageItem && imageItems ? "\n" : "") + imageItems;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background-color: #f8fafc;
            color: #334155;
            line-height: 1.6;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem 1rem;
            text-align: center;
            margin-bottom: 2rem;
        }

        .header h1 {
            font-size: 2.5rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
        }

        .header .subtitle {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .container {
            width: 100%;
            margin: 0;
            padding: 0 1rem;
        }

        .gallery {
            display: grid;
            grid-template-columns: repeat(var(--columns, ${columns}), 1fr);
            gap: 1.5rem;
            margin-bottom: 3rem;
            transition: all 0.3s ease;
        }

        @media (max-width: 1200px) {
            .gallery {
                grid-template-columns: repeat(min(var(--columns, ${columns}), 6), 1fr);
            }
        }

        @media (max-width: 768px) {
            .gallery {
                grid-template-columns: repeat(min(var(--columns, ${columns}), 3), 1fr);
                gap: 1rem;
            }
        }

        @media (max-width: 480px) {
            .gallery {
                grid-template-columns: repeat(min(var(--columns, ${columns}), 2), 1fr);
            }
        }

        .gallery-item {
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        }

        .gallery-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px -3px rgba(0, 0, 0, 0.1);
        }

        .image-container {
            position: relative;
            aspect-ratio: 1;
            overflow: hidden;
            background: #f1f5f9;
        }

        .image-container img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            transition: transform 0.3s ease;
        }

        .gallery-item:hover .image-container img {
            transform: scale(1.05);
        }

        .image-info {
            padding: 1rem;
        }

        .filename {
            font-weight: 600;
            color: #1e293b;
            margin-bottom: 0.5rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-size: 0.9rem;
        }

        .metadata {
            font-size: 0.75rem;
            color: #64748b;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .separator {
            color: #cbd5e1;
        }

        .stats {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            margin-bottom: 2rem;
        }

        .stats h2 {
            color: #1e293b;
            margin-bottom: 1rem;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
        }

        .stat-item {
            text-align: center;
            padding: 1rem;
            background: #f8fafc;
            border-radius: 8px;
        }

        .stat-number {
            font-size: 2rem;
            font-weight: 700;
            color: #667eea;
            display: block;
        }

        .stat-label {
            font-size: 0.9rem;
            color: #64748b;
            margin-top: 0.25rem;
        }

        .footer {
            text-align: center;
            padding: 2rem;
            color: #64748b;
            font-size: 0.9rem;
        }

        /* Original image grid item styles */
        .original-image-item {
            position: relative;
        }

        .original-badge {
            position: absolute;
            top: 8px;
            left: 8px;
            background: rgba(102, 126, 234, 0.9);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            z-index: 10;
        }

        /* Column control integrated in stats */
        .column-control {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .column-control label {
            font-weight: 600;
            color: #1e293b;
            font-size: 0.8rem;
        }

        .column-slider {
            width: 200px;
            height: 6px;
            border-radius: 3px;
            background: #e2e8f0;
            outline: none;
            cursor: pointer;
        }

        .column-slider::-webkit-slider-thumb {
            appearance: none;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: #667eea;
            cursor: pointer;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .column-slider::-moz-range-thumb {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: #667eea;
            cursor: pointer;
            border: none;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .column-display {
            font-weight: 700;
            color: #667eea;
            font-size: 1.1rem;
            min-width: 20px;
            text-align: center;
        }

        /* Lightbox styles */
        .lightbox {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.9);
            cursor: pointer;
        }

        .lightbox-content {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            max-width: 90%;
            max-height: 90%;
        }

        .lightbox img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }
    </style>
</head>
<body>
    <header class="header">
        <h1>${title}</h1>
        <div class="subtitle">${files.length} images • <span id="current-columns">${columns}</span> columns</div>
    </header>

    <div class="container">

        <div class="stats">
            <h2>Gallery Statistics</h2>
            <div class="stats-grid">
                <div class="stat-item">
                    <span class="stat-number">${files.length}</span>
                    <div class="stat-label">Total Images</div>
                </div>
                <div class="stat-item">
                    <span class="stat-number" id="stat-columns">${columns}</span>
                    <div class="stat-label">Columns</div>
                    <div class="column-control">
                        <label for="column-slider">Adjust:</label>
                        <input type="range" id="column-slider" class="column-slider" min="1" max="12" value="${columns}" />
                    </div>
                </div>
                <div class="stat-item">
                    <span class="stat-number">${this.getTotalSize(files)}</span>
                    <div class="stat-label">Total Size</div>
                </div>
                <div class="stat-item">
                    <span class="stat-number">${this.getUniqueExtensions(files).join(", ")}</span>
                    <div class="stat-label">File Types</div>
                </div>
            </div>
        </div>

        <div class="gallery">
            ${allImageItems}
        </div>
    </div>

    <footer class="footer">
        Generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}
    </footer>

    <!-- Lightbox -->
    <div id="lightbox" class="lightbox" onclick="closeLightbox()">
        <div class="lightbox-content">
            <img id="lightbox-img" src="" alt="">
        </div>
    </div>

    <script>
        // Add click listeners to images for lightbox
        document.querySelectorAll('.gallery-item img').forEach(img => {
            img.addEventListener('click', (e) => {
                e.stopPropagation();
                openLightbox(img.src);
            });
        });

        function openLightbox(src) {
            const lightbox = document.getElementById('lightbox');
            const lightboxImg = document.getElementById('lightbox-img');
            lightboxImg.src = src;
            lightbox.style.display = 'block';
            document.body.style.overflow = 'hidden';
        }

        function closeLightbox() {
            const lightbox = document.getElementById('lightbox');
            lightbox.style.display = 'none';
            document.body.style.overflow = 'auto';
        }

        // Close lightbox with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeLightbox();
            }
        });

        // Dynamic column control
        const columnSlider = document.getElementById('column-slider');
        const currentColumns = document.getElementById('current-columns');
        const statColumns = document.getElementById('stat-columns');
        const gallery = document.querySelector('.gallery');

        columnSlider.addEventListener('input', (e) => {
            const columns = e.target.value;
            currentColumns.textContent = columns;
            statColumns.textContent = columns;
            gallery.style.setProperty('--columns', columns);
        });
    </script>
</body>
</html>`;
  }

  private formatFileSize(bytes: number): string {
    const sizes = ["B", "KB", "MB", "GB"];
    if (bytes === 0) {
      return "0 B";
    }
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 10) / 10 + " " + sizes[i];
  }

  private getTotalSize(files: string[]): string {
    const totalBytes = files.reduce((sum, file) => {
      try {
        return sum + statSync(file).size;
      } catch {
        return sum;
      }
    }, 0);
    return this.formatFileSize(totalBytes);
  }

  private getUniqueExtensions(files: string[]): string[] {
    const extensions = new Set(files.map((file) => extname(file).toLowerCase().substring(1)));
    return Array.from(extensions).sort();
  }
}

function main(): void {
  const program = new Command();

  program
    .name("generate-gallery")
    .description("Generate an HTML gallery from images in a directory")
    .version("1.0.0");

  program
    .argument("<input-dir>", "Directory containing images")
    .option("-o, --output <file>", "Output HTML file", "gallery.html")
    .option("-c, --columns <number>", "Number of columns in the grid", "8")
    .option("-t, --title <title>", "Gallery title", "Image Gallery")
    .option("-s, --sort <method>", "Sort method: name, date, size", "name")
    .option("--hide-filenames", "Hide filenames and metadata")
    .option("--original-image <file>", "Original image to display at the top")
    .action((inputDir, options) => {
      try {
        const galleryOptions: GalleryOptions = {
          columns: parseInt(options.columns),
          title: options.title,
          outputFile: options.output,
          sortBy: options.sort as "name" | "date" | "size",
          showFilenames: !options.hideFilenames,
          originalImage: options.originalImage,
        };

        const generator = new HTMLGalleryGenerator();
        generator.generateGallery(inputDir, galleryOptions);
      } catch (error) {
        console.error("Error:", error);
        process.exit(1);
      }
    });

  program.parse();
}

if (import.meta.main) {
  main();
}
