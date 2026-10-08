import type { Metadata } from "next";
import TrainingView from "./training-view";

export const metadata: Metadata = { title: "Entrenamiento · Microbot Dashboard" };

export default function TrainingPage() {
  return <TrainingView />;
}
