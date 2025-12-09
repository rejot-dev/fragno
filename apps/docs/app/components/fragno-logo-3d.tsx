import { useEffect, useRef, useState } from "react";
import Zdog from "zdog";

type ColorScheme = {
  frontFace: string;
  rearFace: string;
  leftFace: string;
  rightFace: string;
  topFace: string;
  bottomFace: string;
};

const COLORS: ColorScheme[] = [
  // Red (front)
  {
    frontFace: "#ff6467",
    rearFace: "#e85558",
    leftFace: "#ff6467",
    rightFace: "#d94a4d",
    topFace: "#ff9a9c",
    bottomFace: "#c43e40",
  },
  // Yellow (middle)
  {
    frontFace: "#fdc700",
    rearFace: "#fdd633",
    leftFace: "#fdc700",
    rightFace: "#e6b800",
    topFace: "#fee566",
    bottomFace: "#d4a800",
  },
  // Blue (back)
  {
    frontFace: "#51a2ff",
    rearFace: "#6bb0ff",
    leftFace: "#51a2ff",
    rightFace: "#3d8fe6",
    topFace: "#a3ceff",
    bottomFace: "#2d7acc",
  },
];
const INITIAL_ROTATION = { x: 0.893, y: 6.464, z: 0.5 };

function drawFOutline(
  addTo: Zdog.Illustration | Zdog.Anchor,
  unit: number,
  zOffset: number,
  strokeWidth = 2,
) {
  const depth = unit / 1.5;
  const hd = depth / 2;
  // Small expansion to prevent z-fighting with box faces
  const expand = 0.1;

  // 10 corners of the F perimeter (clockwise from top-left)
  // A--------------B
  // |              |
  // |    D---------C
  // |    |
  // |    E---------F
  // |              |
  // |    H---------G
  // |    |
  // J----I
  const corners2D = [
    { x: -2 * unit - expand, y: -2.5 * unit - expand }, // A: top-left (outer)
    { x: 1 * unit + expand, y: -2.5 * unit - expand }, // B: top-right (outer)
    { x: 1 * unit + expand, y: -1.5 * unit + expand }, // C: bottom-right of top bar (outer right, inner bottom)
    { x: -1 * unit + expand, y: -1.5 * unit + expand }, // D: inner corner (inner)
    { x: -1 * unit + expand, y: -0.5 * unit - expand }, // E: inner corner (inner)
    { x: 1 * unit + expand, y: -0.5 * unit - expand }, // F: top-right of middle bar (outer right, inner top)
    { x: 1 * unit + expand, y: 0.5 * unit + expand }, // G: bottom-right of middle bar (outer)
    { x: -1 * unit + expand, y: 0.5 * unit + expand }, // H: inner corner (inner)
    { x: -1 * unit + expand, y: 2.5 * unit + expand }, // I: bottom-right of spine (inner right, outer bottom)
    { x: -2 * unit - expand, y: 2.5 * unit + expand }, // J: bottom-left of spine (outer)
  ];

  // Create front and back face corners with z expansion
  const frontCorners = corners2D.map((c) => ({ ...c, z: zOffset + hd + expand }));
  const backCorners = corners2D.map((c) => ({ ...c, z: zOffset - hd - expand }));

  // Draw front face perimeter (10 edges)
  for (let i = 0; i < frontCorners.length; i++) {
    const next = (i + 1) % frontCorners.length;
    new Zdog.Shape({
      addTo,
      path: [frontCorners[i], frontCorners[next]],
      stroke: strokeWidth,
      color: "#000",
    });
  }

  // Draw back face perimeter (10 edges)
  for (let i = 0; i < backCorners.length; i++) {
    const next = (i + 1) % backCorners.length;
    new Zdog.Shape({
      addTo,
      path: [backCorners[i], backCorners[next]],
      stroke: strokeWidth,
      color: "#000",
    });
  }

  // Draw depth edges connecting front to back (10 edges)
  for (let i = 0; i < frontCorners.length; i++) {
    new Zdog.Shape({
      addTo,
      path: [frontCorners[i], backCorners[i]],
      stroke: strokeWidth,
      color: "#000",
    });
  }
}

function createF(illo: Zdog.Illustration, unit: number, zOffset: number, colors: ColorScheme) {
  const depth = unit / 1.5;
  const stemHeight = unit * 4; // 1 unit smaller to make room for cap
  const stemX = -unit * 1.5;
  const topY = -unit * 2; // Top of the F (where cap sits)

  // Cap (cube at top-left corner where stem meets top bar)
  new Zdog.Box({
    addTo: illo,
    width: unit,
    height: unit,
    depth: depth,
    translate: { x: stemX, y: topY, z: zOffset },
    ...colors,
    bottomFace: false,
    rightFace: false,
  });

  // Top bar (extends right from cap)
  new Zdog.Box({
    addTo: illo,
    width: unit * 2,
    height: unit,
    depth: depth,
    translate: { x: stemX + unit * 1.5, y: topY, z: zOffset },
    ...colors,
    leftFace: false,
  });

  // Vertical spine (below cap)
  new Zdog.Box({
    addTo: illo,
    width: unit,
    height: stemHeight,
    depth: depth,
    translate: { x: stemX, y: topY + unit / 2 + stemHeight / 2, z: zOffset },
    ...colors,
    topFace: false,
  });

  // Middle bar (1 unit below top bar)
  new Zdog.Box({
    addTo: illo,
    width: unit * 2,
    height: unit,
    depth: depth,
    translate: { x: stemX + unit * 1.5, y: topY + unit * 2, z: zOffset },
    ...colors,
    leftFace: false,
  });

  // Draw outline for entire F shape
  drawFOutline(illo, unit, zOffset);
}

type FragnoLogo3DProps = {
  size?: number;
  dragRotate?: boolean;
  showRotation?: boolean;
  className?: string;
};

export function FragnoLogo3D({
  size = 240,
  dragRotate = false,
  showRotation = false,
  className,
}: FragnoLogo3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rotation, setRotation] = useState(INITIAL_ROTATION);

  const unit = size / 7;

  useEffect(() => {
    if (!canvasRef.current) {
      return;
    }

    const illo = new Zdog.Illustration({
      element: canvasRef.current,
      dragRotate,
      rotate: INITIAL_ROTATION,
    });

    // Create three stacked F's
    createF(illo, unit, unit / 1.5, COLORS[0]);
    createF(illo, unit, 0, COLORS[1]);
    createF(illo, unit, -unit / 1.5, COLORS[2]);

    if (!dragRotate) {
      illo.updateRenderGraph();
      return;
    }

    let animationId: number;
    let frameCount = 0;
    function animate() {
      illo.updateRenderGraph();

      if (showRotation) {
        frameCount++;
        if (frameCount % 10 === 0) {
          setRotation({
            x: illo.rotate.x,
            y: illo.rotate.y,
            z: illo.rotate.z,
          });
        }
      }

      animationId = requestAnimationFrame(animate);
    }
    animate();

    return () => cancelAnimationFrame(animationId);
  }, [unit, dragRotate, showRotation]);

  return (
    <div className={className}>
      <canvas ref={canvasRef} width={size} height={size} />
      {showRotation && (
        <div className="text-fd-muted-foreground flex justify-center gap-4 font-mono text-sm">
          <span>x: {rotation.x.toFixed(3)}</span>
          <span>y: {rotation.y.toFixed(3)}</span>
          <span>z: {rotation.z.toFixed(3)}</span>
        </div>
      )}
    </div>
  );
}
