import { useRef, useState, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

const DEFAULT_COLORS = [
  "#ef4444", // Red (top) - Tailwind red-500
  "#eab308", // Yellow (middle) - Tailwind yellow-500
  "#3b82f6", // Blue (bottom) - Tailwind blue-500
];

const INITIAL_ROTATION: [number, number, number] = [-0.8, -0.3, -0.4];
const START_ROTATION: [number, number, number] = [-1.5, 0.5, -0.8];

const UNIT = 1;
const DEPTH = UNIT / 1.5;
const LAYER_OFFSET = DEPTH + 0.05; // 0.05 to account for outline geometry to come through
const START_LAYER_OFFSET = LAYER_OFFSET * 4; // Start spread apart

const ANIMATION_DURATION = 0.5; // seconds

// Ease out cubic for snappy animation
function easeInOutExpo(x: number): number {
  return x === 0
    ? 0
    : x === 1
      ? 1
      : x < 0.5
        ? Math.pow(2, 20 * x - 10) / 2
        : (2 - Math.pow(2, -20 * x + 10)) / 2;
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

// Create the F shape as a 2D path
function createFShape(): THREE.Shape {
  const shape = new THREE.Shape();

  // F outline (clockwise from top-left)
  // The shape spans: X: -2 to +1, Y: -2.5 to +2.5
  const u = UNIT;

  // Start at top-left (A)
  shape.moveTo(-2 * u, 2.5 * u);
  // Top edge to top-right (B)
  shape.lineTo(1 * u, 2.5 * u);
  // Down to bottom of top bar (C)
  shape.lineTo(1 * u, 1.5 * u);
  // Left to inner corner (D)
  shape.lineTo(-1 * u, 1.5 * u);
  // Down to top of middle bar gap (E)
  shape.lineTo(-1 * u, 0.5 * u);
  // Right to middle bar end (F)
  shape.lineTo(1 * u, 0.5 * u);
  // Down to bottom of middle bar (G)
  shape.lineTo(1 * u, -0.5 * u);
  // Left to inner corner (H)
  shape.lineTo(-1 * u, -0.5 * u);
  // Down to bottom of spine (I)
  shape.lineTo(-1 * u, -2.5 * u);
  // Left to bottom-left (J)
  shape.lineTo(-2 * u, -2.5 * u);
  // Close back to start
  shape.closePath();

  return shape;
}

// Single F layer component
function FLayer({
  zOffset,
  color,
  linewidth = 0,
}: {
  zOffset: number;
  color: string;
  linewidth?: number;
}) {
  const { size } = useThree();

  const { geometry, material, lineSegments, lineMaterial } = useMemo(() => {
    const shape = createFShape();
    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: DEPTH,
      bevelEnabled: false,
    };
    const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    // Center the geometry on Z axis
    geo.translate(0, 0, -DEPTH / 2);

    const mat = new THREE.MeshStandardMaterial({ color });

    // Create thick lines using Line2
    if (linewidth > 0) {
      const edges = new THREE.EdgesGeometry(geo);
      const positions = edges.attributes.position.array as Float32Array;
      const lineGeo = new LineSegmentsGeometry();
      lineGeo.setPositions(positions);

      const lineMat = new LineMaterial({
        color: 0x000000,
        linewidth,
      });

      const lines = new LineSegments2(lineGeo, lineMat);

      return { geometry: geo, material: mat, lineSegments: lines, lineMaterial: lineMat };
    }
    return { geometry: geo, material: mat, lineSegments: undefined, lineMaterial: undefined };
  }, [color, linewidth]);

  // Update line material resolution when size changes
  useEffect(() => {
    if (lineMaterial) {
      lineMaterial.resolution.set(size.width, size.height);
    }
  }, [size, lineMaterial]);

  return (
    <group position={[0, 0, zOffset]}>
      <mesh geometry={geometry} material={material} />
      {lineSegments && <primitive object={lineSegments} />}
    </group>
  );
}

// Scene with all three F layers
function Scene({
  dragRotate,
  onRotationChange,
  colors,
  linewidth,
}: {
  dragRotate: boolean;
  onRotationChange?: (rotation: { x: number; y: number; z: number }) => void;
  colors: [string, string, string];
  linewidth: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const frameCount = useRef(0);
  const animationTime = useRef(0);
  const animationComplete = useRef(false);
  const [layerOffset, setLayerOffset] = useState(START_LAYER_OFFSET);
  const { gl } = useThree();

  useFrame((_, delta) => {
    // Intro animation
    if (!animationComplete.current) {
      animationTime.current += delta;
      const progress = Math.min(animationTime.current / ANIMATION_DURATION, 1);
      const eased = easeInOutExpo(progress);

      // Animate layer offset
      const currentOffset = lerp(START_LAYER_OFFSET, LAYER_OFFSET, eased);
      setLayerOffset(currentOffset);

      // Animate rotation
      if (groupRef.current) {
        groupRef.current.rotation.x = lerp(START_ROTATION[0], INITIAL_ROTATION[0], eased);
        groupRef.current.rotation.y = lerp(START_ROTATION[1], INITIAL_ROTATION[1], eased);
        groupRef.current.rotation.z = lerp(START_ROTATION[2], INITIAL_ROTATION[2], eased);
      }

      if (progress >= 1) {
        animationComplete.current = true;
      }
    }

    // Report rotation changes
    if (onRotationChange && groupRef.current) {
      frameCount.current++;
      if (frameCount.current % 10 === 0) {
        onRotationChange({
          x: groupRef.current.rotation.x,
          y: groupRef.current.rotation.y,
          z: groupRef.current.rotation.z,
        });
      }
    }
  });

  // Handle drag on canvas element directly for reliable tracking
  useEffect(() => {
    if (!dragRotate) return;

    const canvas = gl.domElement;
    let isDragging = false;
    let previousMouse = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      previousMouse = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerUp = (e: PointerEvent) => {
      isDragging = false;
      canvas.releasePointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging || !groupRef.current) return;

      const deltaX = e.clientX - previousMouse.x;
      const deltaY = e.clientY - previousMouse.y;

      groupRef.current.rotation.y += deltaX * 0.01;
      groupRef.current.rotation.x += deltaY * 0.01;

      previousMouse = { x: e.clientX, y: e.clientY };
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerUp);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerUp);
    };
  }, [dragRotate, gl]);

  return (
    <>
      <ambientLight intensity={1} />
      <directionalLight position={[5, 5, 10]} intensity={2.4} />
      <group ref={groupRef} rotation={START_ROTATION}>
        <FLayer linewidth={linewidth} zOffset={layerOffset} color={colors[0]} />
        <FLayer linewidth={linewidth} zOffset={0} color={colors[1]} />
        <FLayer linewidth={linewidth} zOffset={-layerOffset} color={colors[2]} />
      </group>
    </>
  );
}

type FragnoLogo3DThreeProps = {
  size?: number;
  dragRotate?: boolean;
  showRotation?: boolean;
  className?: string;
  colors?: [string, string, string];
  linewidth?: number;
};

export function FragnoLogo3DThree({
  size = 240,
  dragRotate = false,
  showRotation = false,
  className,
  colors = DEFAULT_COLORS as [string, string, string],
  linewidth = 2,
}: FragnoLogo3DThreeProps) {
  const [rotation, setRotation] = useState({
    x: INITIAL_ROTATION[0],
    y: INITIAL_ROTATION[1],
    z: INITIAL_ROTATION[2],
  });

  // F shape spans ~6 units, zoom to fit canvas
  const zoom = size / 7;

  return (
    <div className={className}>
      <div style={{ width: size, height: size }}>
        <Canvas
          orthographic
          camera={{
            zoom,
            position: [0, 0, 100],
            near: 0.1,
            far: 1000,
          }}
          style={{ background: "transparent" }}
        >
          <Scene
            dragRotate={dragRotate}
            onRotationChange={showRotation ? setRotation : undefined}
            colors={colors}
            linewidth={linewidth}
          />
        </Canvas>
      </div>
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
