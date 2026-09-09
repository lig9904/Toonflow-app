import { EventEmitter } from "node:events";
export interface ProductionChange { projectId: number; scriptId: number; storyboardId?: number }
export const productionEvents = new EventEmitter();
export function notifyProductionChange(change: ProductionChange) { productionEvents.emit("changed", change); }
