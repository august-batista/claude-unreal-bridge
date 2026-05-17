import type { UEInstallation } from "../types/ue-project.js";
export declare const HOST_PLATFORM: Record<string, string>;
export declare function findUEInstallations(): UEInstallation[];
export declare function findBestInstallation(targetVersion?: string): UEInstallation | null;
export declare function clearCache(): void;
//# sourceMappingURL=engine-locator.d.ts.map