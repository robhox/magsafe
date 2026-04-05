'use client';

import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

type DragState = "idle" | "lifted" | "dragging" | "snapping" | "docked";

type ConnectorPose = {
  left: number;
  top: number;
};

type SnapTarget = {
  x: number;
  y: number;
  magneticRadius: number;
  dockThreshold: number;
};

type SceneSize = {
  width: number;
  height: number;
};

type ScenePoint = {
  left: number;
  top: number;
};

type PointerSession = {
  id: number | null;
  offsetX: number;
  offsetY: number;
  startPointerX: number;
  startPointerY: number;
  startLeft: number;
  startTop: number;
  wasDocked: boolean;
  detached: boolean;
};

type MotionControl = {
  stop: () => void;
};

type PositionAnimationMode = "dock" | "return";

type RendererLike = {
  domElement: HTMLCanvasElement;
  outputColorSpace: string;
  setPixelRatio: (value: number) => void;
  setClearAlpha: (value: number) => void;
  setSize: (width: number, height: number, updateStyle?: boolean) => void;
  render: (scene: unknown, camera: unknown) => void;
  dispose: () => void;
};

type CameraLike = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  position: { z: number };
  updateProjectionMatrix: () => void;
};

type SceneLike = {
  add: (...objects: unknown[]) => void;
};

type DisposableLike = {
  dispose: () => void;
};

type TextureLike = DisposableLike & {
  wrapS: number;
  wrapT: number;
  repeat: {
    set: (x: number, y: number) => void;
  };
  needsUpdate: boolean;
  colorSpace?: string;
};

type MeshLike = {
  geometry: DisposableLike;
};

type Vector2Like = {
  x: number;
  y: number;
  set: (x: number, y: number) => void;
  copy: (point: Vector2Like) => void;
  lerp: (point: Vector2Like, alpha: number) => void;
};

type DirectionalLightLike = {
  position: {
    set: (x: number, y: number, z: number) => void;
  };
};

type ThreeModule = {
  SRGBColorSpace: string;
  WebGLRenderer: new (options: {
    antialias: boolean;
    alpha: boolean;
    powerPreference: string;
  }) => RendererLike;
  Scene: new () => SceneLike;
  OrthographicCamera: new (
    left: number,
    right: number,
    top: number,
    bottom: number,
    near: number,
    far: number
  ) => CameraLike;
  AmbientLight: new (color: number, intensity: number) => unknown;
  DirectionalLight: new (color: number, intensity: number) => DirectionalLightLike;
  RepeatWrapping: number;
  CanvasTexture: new (image: HTMLCanvasElement) => TextureLike;
  MeshStandardMaterial: new (options: {
    color: string;
    roughness: number;
    metalness: number;
    map?: TextureLike;
    bumpMap?: TextureLike;
    bumpScale?: number;
  }) => DisposableLike;
  BufferGeometry: new () => DisposableLike;
  Mesh: new (geometry: DisposableLike, material: DisposableLike) => MeshLike;
  Vector2: new (x?: number, y?: number) => Vector2Like;
  Vector3: new (x?: number, y?: number, z?: number) => unknown;
  CurvePath: new () => {
    add: (curve: unknown) => void;
  };
  CatmullRomCurve3: new (
    points: unknown[],
    closed: boolean,
    curveType: string
  ) => unknown;
  LineCurve3: new (v1: unknown, v2: unknown) => unknown;
  TubeGeometry: new (
    path: unknown,
    tubularSegments: number,
    radius: number,
    radialSegments: number,
    closed: boolean
  ) => DisposableLike;
};

const CONNECTOR_SIZE = {
  width: 68,
  height: 96,
};
const PORT_MASK_RADIUS = 400;

const FRONT_OFFSET = {
  x: CONNECTOR_SIZE.width,
  y: CONNECTOR_SIZE.height / 2,
};

const BACK_OFFSET = {
  x: 10,
  y: CONNECTOR_SIZE.height / 2,
};

const IDLE_SCALE = 1;
const LIFT_SCALE = 1.018;
const IDLE_LIFT = 0;
const ACTIVE_LIFT = -14;
const REDUCED_ACTIVE_LIFT = -8;
const DETACH_DISTANCE = 18;
const DETACH_RESISTANCE = 0.62;
const RIGID_TAIL = 0;
const HIDDEN_TAIL_GUIDE = 14;

/* ─────────────────────────────────────────────────────────
 * CONNECTOR MOTION STORYBOARD
 *
 *    0ms   pointer down lifts the connector
 *   drag   magnet can pull it into the dock
 * release  if aligned, snap into the port
 * release  otherwise spring back to the home pose
 * ───────────────────────────────────────────────────────── */

const POSITION_SPRING = {
  dock: {
    reduced: { stiffness: 360, damping: 38 },
    default: { stiffness: 520, damping: 28 },
  },
  return: {
    reduced: { stiffness: 280, damping: 34 },
    default: { stiffness: 360, damping: 30 },
  },
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function createBraidedTexture() {
  if (typeof document === "undefined") {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 96;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.fillStyle = "#f9f8f4";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "rgba(198, 202, 208, 0.34)";
  context.lineWidth = 2;

  for (
    let index = -canvas.height;
    index < canvas.width + canvas.height;
    index += 14
  ) {
    context.beginPath();
    context.moveTo(index, 0);
    context.lineTo(index + canvas.height, canvas.height);
    context.stroke();
  }

  context.strokeStyle = "rgba(255, 255, 255, 0.46)";
  context.lineWidth = 1.4;

  for (let index = 0; index < canvas.width + canvas.height; index += 14) {
    context.beginPath();
    context.moveTo(index, 0);
    context.lineTo(index - canvas.height, canvas.height);
    context.stroke();
  }

  context.fillStyle = "rgba(255, 255, 255, 0.32)";
  context.fillRect(0, 0, canvas.width, canvas.height * 0.36);

  return canvas;
}

function computeSnapTarget(size: SceneSize): SnapTarget {
  return {
    x: size.width - clamp(size.width * 0.14, 116, 190),
    y: size.height * 0.25,
    magneticRadius: clamp(size.width * 0.12, 88, 150),
    dockThreshold: 16,
  };
}

function computeDockPose(target: SnapTarget): ConnectorPose {
  return {
    left: target.x - FRONT_OFFSET.x,
    top: target.y - FRONT_OFFSET.y,
  };
}

function computeStartPose(size: SceneSize): ConnectorPose {
  return {
    left: clamp(size.width * 0.18, 36, 230) - FRONT_OFFSET.x,
    top: size.height * 0.5 - FRONT_OFFSET.y,
  };
}

function computeHomePose(size: SceneSize): ConnectorPose {
  return clampPose(computeStartPose(size), size);
}

function clampPose(pose: ConnectorPose, size: SceneSize): ConnectorPose {
  const maxLeft = Math.max(20, size.width - CONNECTOR_SIZE.width - 18);
  const maxTop = Math.max(24, size.height - CONNECTOR_SIZE.height - 24);

  return {
    left: clamp(pose.left, 20, maxLeft),
    top: clamp(pose.top, 24, maxTop),
  };
}

export default function MagSafeHero() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const cableMountRef = useRef<HTMLDivElement>(null);
  const deviceRef = useRef<HTMLDivElement>(null);
  const portEdgeRef = useRef<HTMLSpanElement>(null);
  const sizeRef = useRef<SceneSize>({ width: 0, height: 0 });
  const snapTargetRef = useRef<SnapTarget>({
    x: 0,
    y: 0,
    magneticRadius: 120,
    dockThreshold: 16,
  });
  const hasPlacedConnectorRef = useRef(false);
  const dragStateRef = useRef<DragState>("idle");
  const pointerSessionRef = useRef<PointerSession>({
    id: null,
    offsetX: 0,
    offsetY: 0,
    startPointerX: 0,
    startPointerY: 0,
    startLeft: 0,
    startTop: 0,
    wasDocked: false,
    detached: false,
  });
  const positionAnimationsRef = useRef<MotionControl[]>([]);
  const [dragState, setDragState] = useState<DragState>("idle");
  const [sceneReady, setSceneReady] = useState(false);
  const [portGuidePosition, setPortGuidePosition] = useState<ScenePoint>({
    left: 0,
    top: 0,
  });
  const reducedMotion = useReducedMotion();

  const left = useMotionValue(0);
  const top = useMotionValue(0);
  const lift = useMotionValue(0);
  const scale = useMotionValue(1);
  const tilt = useMotionValue(0);
  const portMaskSize = PORT_MASK_RADIUS * 2;
  const portMaskX = useTransform(
    () => left.get() + FRONT_OFFSET.x - PORT_MASK_RADIUS,
  );
  const portMaskY = useTransform(
    () => top.get() + FRONT_OFFSET.y - PORT_MASK_RADIUS,
  );

  function syncDragState(nextState: DragState) {
    dragStateRef.current = nextState;
    setDragState(nextState);
  }

  function stopPositionAnimations() {
    positionAnimationsRef.current.forEach((control) => control.stop());
    positionAnimationsRef.current = [];
  }

  function animateConnectorPosition(
    targetPose: ConnectorPose,
    mode: PositionAnimationMode = "dock",
  ) {
    stopPositionAnimations();
    const spring = reducedMotion
      ? POSITION_SPRING[mode].reduced
      : POSITION_SPRING[mode].default;

    positionAnimationsRef.current = [
      animate(left, targetPose.left, {
        type: "spring",
        ...spring,
      }),
      animate(top, targetPose.top, {
        type: "spring",
        ...spring,
      }),
    ];
  }

  function animateActivePose() {
    animate(lift, reducedMotion ? REDUCED_ACTIVE_LIFT : ACTIVE_LIFT, {
      duration: 0.16,
      ease: [0.22, 1, 0.36, 1],
    });
    animate(scale, LIFT_SCALE, {
      duration: 0.16,
      ease: [0.22, 1, 0.36, 1],
    });
  }

  function settleConnector(restingState: DragState) {
    animate(lift, IDLE_LIFT, {
      duration: reducedMotion ? 0.12 : 0.18,
      ease: [0.22, 1, 0.36, 1],
    });
    animate(scale, IDLE_SCALE, {
      duration: reducedMotion ? 0.12 : 0.18,
      ease: [0.22, 1, 0.36, 1],
    });
    animate(tilt, restingState === "docked" ? -0.8 : 0, {
      duration: reducedMotion ? 0.16 : 0.24,
      ease: [0.22, 1, 0.36, 1],
    });
  }

  function applyMagnet(freePose: ConnectorPose) {
    const size = sizeRef.current;
    const target = snapTargetRef.current;
    const dockPose = clampPose(computeDockPose(target), size);

    const dx = target.x - (freePose.left + FRONT_OFFSET.x);
    const dy = target.y - (freePose.top + FRONT_OFFSET.y);
    const distance = Math.hypot(dx, dy);

    if (distance <= target.dockThreshold) {
      return {
        pose: dockPose,
        state: "docked" as const,
      };
    }

    if (distance <= target.magneticRadius) {
      const attraction = 0.18 + easeOutCubic(1 - distance / target.magneticRadius) * 0.62;

      return {
        pose: {
          left: lerp(freePose.left, dockPose.left, attraction),
          top: lerp(freePose.top, dockPose.top, attraction),
        },
        state: "snapping" as const,
      };
    }

    return {
      pose: freePose,
      state: "dragging" as const,
    };
  }

  useEffect(() => {
    const scene = sceneRef.current;

    if (!scene) {
      return;
    }

    const measure = () => {
      const rect = scene.getBoundingClientRect();
      const nextSize = {
        width: rect.width,
        height: rect.height,
      };

      sizeRef.current = nextSize;
      const device = deviceRef.current;
      if (device) {
        const deviceRect = device.getBoundingClientRect();
        const nextPortGuidePosition = {
          left: deviceRect.left - rect.left,
          top: deviceRect.top - rect.top + deviceRect.height * 0.25,
        };

        setPortGuidePosition((current) =>
          current.left === nextPortGuidePosition.left &&
          current.top === nextPortGuidePosition.top
            ? current
            : nextPortGuidePosition,
        );
      }

      const portEdge = portEdgeRef.current;
      const nextSnapTarget = portEdge
        ? (() => {
            const edgeRect = portEdge.getBoundingClientRect();

            return {
              x: edgeRect.right - rect.left + 4,
              y: edgeRect.top - rect.top + edgeRect.height / 2,
              magneticRadius: clamp(nextSize.width * 0.12, 88, 150),
              dockThreshold: 16,
            };
          })()
        : computeSnapTarget(nextSize);
      snapTargetRef.current = nextSnapTarget;

      if (!hasPlacedConnectorRef.current) {
        const startPose = computeHomePose(nextSize);
        left.set(startPose.left);
        top.set(startPose.top);
        hasPlacedConnectorRef.current = true;
      } else if (pointerSessionRef.current.id === null) {
        if (dragStateRef.current === "docked") {
          const dockPose = clampPose(computeDockPose(snapTargetRef.current), nextSize);
          left.set(dockPose.left);
          top.set(dockPose.top);
        } else {
          const currentPose = clampPose(
            {
              left: left.get(),
              top: top.get(),
            },
            nextSize
          );
          left.set(currentPose.left);
          top.set(currentPose.top);
        }
      }

      setSceneReady(nextSize.width > 0 && nextSize.height > 0);
    };

    const resizeObserver = new ResizeObserver(() => {
      measure();
    });

    resizeObserver.observe(scene);
    measure();

    return () => {
      resizeObserver.disconnect();
    };
  }, [left, top]);

  useEffect(() => {
    const mount = cableMountRef.current;

    if (!mount) {
      return;
    }

    let cancelled = false;
    let cleanup = () => {};

    void (async () => {
      const THREE = (await import("three")) as unknown as ThreeModule;

      if (cancelled) {
        return;
      }

      let renderer: RendererLike | null = null;

      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        });
      } catch {
        return;
      }

      const pixelRatio =
        typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio ?? 1, 1.75);

      renderer.setPixelRatio(pixelRatio);
      renderer.setClearAlpha(0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.style.position = "absolute";
      renderer.domElement.style.inset = "0";
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -100, 100);
      camera.position.z = 20;

      const ambientLight = new THREE.AmbientLight(0xffffff, 1.3);
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.65);
      directionalLight.position.set(-120, 180, 120);
      scene.add(ambientLight, directionalLight);

      const cableTextureCanvas = createBraidedTexture();
      const cableTexture = cableTextureCanvas
        ? new THREE.CanvasTexture(cableTextureCanvas)
        : null;

      if (cableTexture) {
        cableTexture.wrapS = THREE.RepeatWrapping;
        cableTexture.wrapT = THREE.RepeatWrapping;
        cableTexture.repeat.set(reducedMotion ? 7 : 10, 1.85);
        cableTexture.colorSpace = THREE.SRGBColorSpace;
        cableTexture.needsUpdate = true;
      }

      const cableMaterial = new THREE.MeshStandardMaterial({
        color: "#fcfbf7",
        roughness: 0.86,
        metalness: 0.04,
        map: cableTexture ?? undefined,
        bumpMap: cableTexture ?? undefined,
        bumpScale: reducedMotion ? 0.05 : 0.1,
      });

      const cableMesh = new THREE.Mesh(new THREE.BufferGeometry(), cableMaterial);
      scene.add(cableMesh);

      const controlPoints = Array.from({ length: 3 }, () => new THREE.Vector2());
      const lead = new THREE.Vector2();
      const previousLead = new THREE.Vector2();

      let frameId = 0;

      const renderFrame = () => {
        frameId = window.requestAnimationFrame(renderFrame);

        const { width, height } = sizeRef.current;

        if (!width || !height) {
          return;
        }

        if (
          renderer &&
          (renderer.domElement.width !== Math.round(width * pixelRatio) ||
            renderer.domElement.height !== Math.round(height * pixelRatio))
        ) {
          renderer.setSize(width, height, false);
          camera.left = 0;
          camera.right = width;
          camera.top = height;
          camera.bottom = 0;
          camera.updateProjectionMatrix();
        }

        const start = new THREE.Vector2(-120, height * 0.5);
        const liftOffset = lift.get() * 0.45;
        const rigidTail = clamp(RIGID_TAIL, 0, 80);

        lead.set(left.get() + BACK_OFFSET.x, top.get() + BACK_OFFSET.y + liftOffset);
        const entry = new THREE.Vector2(Math.max(start.x, lead.x - rigidTail), lead.y);
        const tailGuide =
          rigidTail > 0
            ? new THREE.Vector2(
                Math.max(start.x, entry.x - Math.min(Math.max(rigidTail * 0.55, 12), 20)),
                entry.y
              )
            : new THREE.Vector2(
                Math.max(start.x, entry.x - HIDDEN_TAIL_GUIDE),
                entry.y
              );

        const velocity = new THREE.Vector2(
          lead.x - previousLead.x,
          lead.y - previousLead.y
        );

        previousLead.copy(lead);

        const distance = Math.hypot(lead.x - start.x, lead.y - start.y);
        const slackBase = reducedMotion ? 14 : 26;
        const slack = clamp(slackBase + distance * 0.05 + Math.abs(velocity.y) * 0.9, 16, 84);
        const followStrength = reducedMotion ? 0.34 : 0.16;

        controlPoints.forEach((point, index) => {
          const t = (index + 1) / (controlPoints.length + 1);
          const desired = new THREE.Vector2(
            lerp(start.x, entry.x, t) - Math.abs(velocity.x) * (1 - t) * 0.4,
            lerp(start.y, entry.y, t) +
              Math.sin(t * Math.PI) * slack -
              velocity.y * (1 - t) * 0.9
          );

          if (!sceneReady) {
            point.copy(desired);
          } else {
            point.lerp(desired, followStrength);
          }
        });

        const pathPoints = [start, ...controlPoints, tailGuide, entry].map(
          (point) => new THREE.Vector3(point.x, height - point.y, 0)
        );

        const curvePath = new THREE.CurvePath();
        curvePath.add(new THREE.CatmullRomCurve3(pathPoints, false, "centripetal"));
        curvePath.add(
          new THREE.LineCurve3(
            new THREE.Vector3(entry.x, height - entry.y, 0),
            new THREE.Vector3(lead.x, height - lead.y, 0)
          )
        );

        const geometry = new THREE.TubeGeometry(
          curvePath,
          reducedMotion ? 30 : 44,
          7,
          reducedMotion ? 10 : 14,
          false
        );

        cableMesh.geometry.dispose();
        cableMesh.geometry = geometry;

        renderer?.render(scene, camera);
      };

      renderFrame();

      cleanup = () => {
        window.cancelAnimationFrame(frameId);
        cableMesh.geometry.dispose();
        cableTexture?.dispose();
        cableMaterial.dispose();
        renderer?.dispose();
        mount.replaceChildren();
      };
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [left, lift, reducedMotion, sceneReady, top]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sceneRef.current || !sceneReady) {
      return;
    }

    event.preventDefault();
    stopPositionAnimations();

    const sceneBounds = sceneRef.current.getBoundingClientRect();
    const currentLeft = left.get();
    const currentTop = top.get();

    pointerSessionRef.current = {
      id: event.pointerId,
      offsetX: event.clientX - sceneBounds.left - currentLeft,
      offsetY: event.clientY - sceneBounds.top - currentTop,
      startPointerX: event.clientX - sceneBounds.left,
      startPointerY: event.clientY - sceneBounds.top,
      startLeft: currentLeft,
      startTop: currentTop,
      wasDocked: dragStateRef.current === "docked",
      detached: dragStateRef.current !== "docked",
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    syncDragState("lifted");
    animateActivePose();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sceneRef.current || pointerSessionRef.current.id !== event.pointerId) {
      return;
    }

    const sceneBounds = sceneRef.current.getBoundingClientRect();
    const pointerX = event.clientX - sceneBounds.left;
    const pointerY = event.clientY - sceneBounds.top;

    const pointerSession = pointerSessionRef.current;
    const deltaX = pointerX - pointerSession.startPointerX;
    const deltaY = pointerY - pointerSession.startPointerY;

    let nextPose: ConnectorPose;

    if (pointerSession.wasDocked && !pointerSession.detached) {
      const travel = Math.hypot(deltaX, deltaY);

      if (travel < DETACH_DISTANCE) {
        tilt.set(clamp(deltaY * 0.12, -3, 2));
        syncDragState("lifted");
        return;
      }

      pointerSession.detached = true;
    }

    if (pointerSession.wasDocked) {
      nextPose = {
        left: pointerSession.startLeft + deltaX * DETACH_RESISTANCE,
        top: pointerSession.startTop + deltaY * DETACH_RESISTANCE,
      };
    } else {
      nextPose = {
        left: pointerX - pointerSession.offsetX,
        top: pointerY - pointerSession.offsetY,
      };
    }

    nextPose = clampPose(nextPose, sizeRef.current);

    const magneticResult = applyMagnet(nextPose);

    left.set(magneticResult.pose.left);
    top.set(magneticResult.pose.top);

    if (magneticResult.state === "docked") {
      syncDragState("docked");
      tilt.set(-2.2);
      return;
    }

    syncDragState(magneticResult.state);

    const targetTilt =
      clamp(deltaY * 0.08, -5.5, 4) + clamp(deltaX * 0.01, -1.5, 1.5);
    tilt.set(targetTilt);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerSessionRef.current.id !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pointerSessionRef.current = {
      id: null,
      offsetX: 0,
      offsetY: 0,
      startPointerX: 0,
      startPointerY: 0,
      startLeft: 0,
      startTop: 0,
      wasDocked: false,
      detached: false,
    };

    if (dragStateRef.current === "docked" || dragStateRef.current === "snapping") {
      animateConnectorPosition(clampPose(computeDockPose(snapTargetRef.current), sizeRef.current));
      syncDragState("docked");
      settleConnector("docked");
      return;
    }

    syncDragState("idle");
    animateConnectorPosition(computeHomePose(sizeRef.current), "return");
    settleConnector("idle");
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    handlePointerUp(event);
  }

  return (
    <section ref={sceneRef} className="magsafe-hero">
      <div className="magsafe-hero__ambient magsafe-hero__ambient--left" />
      <div className="magsafe-hero__ambient magsafe-hero__ambient--right" />

      <div className="magsafe-hero__copy">
        <p className="magsafe-hero__eyebrow">MagSafe study</p>
        <p className="magsafe-hero__headline">
          Lift. Drag. Let the magnet finish.
        </p>
      </div>

      <div
        ref={cableMountRef}
        className="magsafe-cable-layer"
        aria-hidden="true"
      />

      <div
        className="magsafe-port-guide"
        aria-hidden="true"
        style={{
          left: portGuidePosition.left,
          top: portGuidePosition.top,
          opacity: sceneReady ? 1 : 0,
        }}
      >
        <span ref={portEdgeRef} className="magsafe-port-guide__edge" />
        <span className="magsafe-port-guide__arrow" />
      </div>

      <div ref={deviceRef} className="magsafe-device" aria-hidden="true">
        <div className="magsafe-device__sheen" />
      </div>

      <motion.div
        className="magsafe-port-mask"
        aria-hidden="true"
        style={{
          x: portMaskX,
          y: portMaskY,
          width: portMaskSize,
          height: portMaskSize,
          filter: "blur(10px)",
          background:
            "radial-gradient(circle, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 1) 20%, rgba(255, 255, 255, 0) 80%, rgba(255, 255, 255, 0) 100%)",
          // background:
          //   "radial-gradient(circle, rgba(255, 255, 0, 1) 0%, rgba(255, 255, 0, 1) 80%, rgba(255, 255, 0, 0) 100%)",
        }}
      />

      <motion.div
        className="magsafe-connector-anchor"
        data-state={dragState}
        style={{
          x: left,
          y: top,
          opacity: sceneReady ? 1 : 0,
          cursor:
            dragState === "dragging" || dragState === "snapping"
              ? "grabbing"
              : "grab",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <motion.div
          className="magsafe-connector"
          data-state={dragState}
          style={{
            y: lift,
            scale,
            rotate: dragState === "docked" ? 0 : tilt,
          }}
        >
          <span className="magsafe-connector__head">
            <span className="magsafe-connector__shell" />
            <span className="magsafe-connector__led" />
          </span>
        </motion.div>
      </motion.div>
    </section>
  );
}
