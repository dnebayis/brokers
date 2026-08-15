"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider, type State } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children, initialState }: { children: ReactNode; initialState?: State }) {
  // Cache reads for a few seconds and don't refetch on every focus/mount — cuts redundant RPC
  // traffic dramatically when many users are on the app at once.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 2,
          },
        },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
