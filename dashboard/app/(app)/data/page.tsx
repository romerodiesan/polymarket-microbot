import type { Metadata } from "next";
import CollectionView from "./collection-view";

export const metadata: Metadata = { title: "Datos · Microbot Dashboard" };

export default function DataPage() {
  return <CollectionView />;
}
