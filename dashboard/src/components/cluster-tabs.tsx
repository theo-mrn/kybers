"use client";

import * as React from "react";
import { Activity, HardDrive, Info, Server } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

/**
 * Onglets d'une carte cluster.
 *
 * Les informations, les courbes, les nœuds et les composants s'empilaient sur
 * plusieurs écrans de haut : avec plusieurs clusters, la page devenait
 * impraticable. Chaque section a désormais son onglet, et les courbes — les
 * plus hautes — ne se chargent que si on les demande.
 */
export function ClusterTabs({
  overview,
  metrics,
  nodes,
  components,
  nodeCount,
  hasMetrics,
}: {
  overview: React.ReactNode;
  metrics: React.ReactNode;
  nodes: React.ReactNode;
  components: React.ReactNode;
  nodeCount: number;
  hasMetrics: boolean;
}) {
  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList variant="line" className="w-full justify-start">
        <TabsTrigger value="overview">
          <Info className="size-3.5" />
          Vue d&apos;ensemble
        </TabsTrigger>
        <TabsTrigger value="metrics" disabled={!hasMetrics}>
          <Activity className="size-3.5" />
          Consommation
        </TabsTrigger>
        <TabsTrigger value="nodes">
          <Server className="size-3.5" />
          Nœuds
          {nodeCount > 0 && (
            <Badge variant="secondary" className="ml-1">
              {nodeCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="components">
          <HardDrive className="size-3.5" />
          Composants
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="pt-4">
        {overview}
      </TabsContent>
      <TabsContent value="metrics" className="pt-4">
        {metrics}
      </TabsContent>
      <TabsContent value="nodes" className="pt-4">
        {nodes}
      </TabsContent>
      <TabsContent value="components" className="pt-4">
        {components}
      </TabsContent>
    </Tabs>
  );
}
