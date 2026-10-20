/**
 * TL2 milestone: gltfjsx component workflow demo.
 * Wires the committed `PropCrate` generated component into a dev scene.
 */
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Model as PropCrate } from "./generated/PropCrate";

export function DevModelScene() {
  return (
    <div className="h-[300px] w-full rounded-md border bg-slate-950">
      <Canvas camera={{ position: [2, 2, 3], fov: 50 }} flat>
        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 10, 7]} intensity={1.2} />
        <PropCrate position={[0, 0, 0]} scale={1} />
        <OrbitControls />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]}>
          <planeGeometry args={[10, 10]} />
          <meshStandardMaterial color="#334455" />
        </mesh>
      </Canvas>
    </div>
  );
}
