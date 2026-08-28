import { AssetField, MediaType, Query, usePermissions, type PermissionResponse } from "expo-media-library";
import { useCallback, useEffect, useState } from "react";
import { GRID } from "./constants";

export interface LibraryPhoto {
  id: string;
}

export type LibraryStatus = "loading" | "denied" | "empty" | "ready";

export interface PhotoLibrary {
  photos: LibraryPhoto[];
  status: LibraryStatus;
}

function isReadable(permission: PermissionResponse | null) {
  return !!permission && (permission.granted || permission.accessPrivileges === "limited");
}

export function usePhotoLibrary(): PhotoLibrary {
  const [permission, requestPermission] = usePermissions({ granularPermissions: ["photo"] });
  const [photos, setPhotos] = useState<LibraryPhoto[]>([]);
  const [status, setStatus] = useState<LibraryStatus>("loading");

  const load = useCallback(async () => {
    try {
      const assets = await new Query()
        .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
        .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
        .limit(GRID.pageSize)
        .exeForMetadata();
      setPhotos(assets.map((asset) => ({ id: asset.id })));
      setStatus(assets.length ? "ready" : "empty");
    } catch {
      setStatus("denied");
    }
  }, []);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    if (!permission) return;
    if (isReadable(permission)) {
      load();
    } else if (!permission.canAskAgain) {
      setStatus("denied");
    }
  }, [permission, load]);

  return { photos, status };
}
