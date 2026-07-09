import { useEffect, useState } from 'react';
import { commandEve } from '@/common/adapter/ipcBridge';

export type CommandEveFounderBuildState = {
  loading: boolean;
  founderBuild: boolean;
};

export function useCommandEveFounderBuild(): CommandEveFounderBuildState {
  const [state, setState] = useState<CommandEveFounderBuildState>({
    loading: true,
    founderBuild: false,
  });

  useEffect(() => {
    let alive = true;

    commandEve.shellFlags
      .invoke()
      .then((res) => {
        if (!alive) return;
        setState({
          loading: false,
          founderBuild: res?.data?.founder_build === true,
        });
      })
      .catch(() => {
        if (!alive) return;
        setState({ loading: false, founderBuild: false });
      });

    return () => {
      alive = false;
    };
  }, []);

  return state;
}
