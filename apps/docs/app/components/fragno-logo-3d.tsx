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
  });

  // Top bar (extends right from cap)
  new Zdog.Box({
    addTo: illo,
    width: unit * 2, // 2 units extending right
    height: unit,
    depth: depth,
    translate: { x: stemX + unit * 1.5, y: topY, z: zOffset },
    ...colors,
  });

  // Vertical spine (below cap)
  new Zdog.Box({
    addTo: illo,
    width: unit,
    height: stemHeight,
    depth: depth,
    translate: { x: stemX, y: topY + unit / 2 + stemHeight / 2, z: zOffset },
    ...colors,
  });

  // Middle bar (1 unit below top bar)
  new Zdog.Box({
    addTo: illo,
    width: unit * 2,
    height: unit,
    depth: depth,
    translate: { x: stemX + unit * 1.5, y: topY + unit * 2, z: zOffset },
    ...colors,
  });
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
