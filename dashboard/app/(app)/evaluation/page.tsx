import type { Metadata } from "next";
import EvaluationView from "./evaluation-view";

export const metadata: Metadata = { title: "Evaluación · Microbot Dashboard" };

export default function EvaluationPage() {
  return <EvaluationView />;
}
