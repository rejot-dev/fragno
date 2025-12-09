import { useEffect, useRef, useState } from "react";
import Zdog from "zdog";

type ColorScheme = {
  base: string;
  front: string;
  rear: string;
  left: string;
  right: string;
  top: string;
  bottom: string;
};

const COLORS: ColorScheme[] = [
  // Red (front)
  {
    base: "#ff6467",
    front: "#ff8a8c",
    rear: "#e54b4e",
    left: "#ff6467",
    right: "#cc5052",
    top: "#ffb0b2",
    bottom: "#b23e40",
  },
  // Yellow (middle)
  {
    base: "#fdc700",
    front: "#fdd633",
    rear: "#d4a800",
    left: "#fdc700",
    right: "#b89200",
    top: "#fee566",
    bottom: "#9a7a00",
  },
  // Blue (back)
  {
    base: "#51a2ff",
    front: "#7ab8ff",
    rear: "#3a8be6",
    left: "#51a2ff",
    right: "#2d74cc",
    top: "#a3ceff",
    bottom: "#1f5db3",
  },
];

const INITIAL_ROTATION = { x: 0.602, y: 6.83, z: 0 };

function createF(illo: Zdog.Illustration, unit: number, zOffset: number, colors: ColorScheme) {
  const boxStyle = {
    stroke: false,
    color: colors.base,
    frontFace: colors.front,
    rearFace: colors.rear,
    leftFace: colors.left,
    rightFace: colors.right,
    topFace: colors.top,
    bottomFace: colors.bottom,
  };

  const barWidth = unit * 2;
  const stemHeight = unit * 5;
  const stemX = -unit * 1.5;
  const topY = -stemHeight / 2 + unit / 2;

  // Vertical spine
  new Zdog.Box({
    addTo: illo,
    width: unit,
    height: stemHeight,
    depth: unit / 1.5,
    translate: { x: stemX, y: 0, z: zOffset },
    ...boxStyle,
  });

  // Top bar
  new Zdog.Box({
    addTo: illo,
    width: barWidth,
    height: unit,
    depth: unit / 1.5,
    translate: { x: 0, y: topY, z: zOffset },
    ...boxStyle,
  });

  // Middle bar (1 unit below top bar)
  new Zdog.Box({
    addTo: illo,
    width: barWidth,
    height: unit,
    depth: unit / 1.5,
    translate: { x: 0, y: topY + unit * 2, z: zOffset },
    ...boxStyle,
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

  const unit = size / 10;

  useEffect(() => {
    if (!canvasRef.current) {return;}

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
