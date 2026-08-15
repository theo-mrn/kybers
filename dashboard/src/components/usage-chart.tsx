"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AreaChart as AreaIcon,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  LineChart as LineIcon,
  Maximize2,
  RotateCcw,
} from "lucide-react";

import type { UsageSample } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Plages proposées, en minutes.
 *
 * Le Control Plane conserve 24 h d'historique et l'agent relève toutes les
 * 30 s : au-delà de quelques heures, les points sont agrégés (voir `bucket`).
 */
const RANGES = [
  { key: "15m", label: "15 min", minutes: 15 },
  { key: "1h", label: "1 h", minutes: 60 },
  { key: "3h", label: "3 h", minutes: 180 },
  { key: "6h", label: "6 h", minutes: 360 },
  { key: "12h", label: "12 h", minutes: 720 },
  { key: "24h", label: "24 h", minutes: 1440 },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];
type ChartKind = "area" | "line" | "bar";

const chartConfig = {
  cpu: { label: "CPU", color: "var(--chart-2)" },
  memory: { label: "Mémoire", color: "var(--chart-5)" },
} satisfies ChartConfig;

type SeriesKey = keyof typeof chartConfig;

function pct(used: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

/**
 * Agrège les relevés pour ne pas tracer des milliers de points.
 *
 * Sur 24 h à un relevé toutes les 30 s, la série compte ~2880 points : bien
 * plus que de pixels disponibles. On moyenne par tranches, en conservant le
 * maximum de chaque tranche — un pic de charge ne doit pas être lissé au point
 * de disparaître.
 */
function bucket(samples: UsageSample[], target = 140) {
  if (samples.length <= target) {
    return samples.map((s) => ({
      ts: s.ts,
      cpu: pct(s.cpu_millis, s.cpu_capacity),
      memory: pct(s.memory_bytes, s.memory_capacity),
      cpuPeak: pct(s.cpu_millis, s.cpu_capacity),
      memoryPeak: pct(s.memory_bytes, s.memory_capacity),
    }));
  }

  const size = Math.ceil(samples.length / target);
  const out = [];

  for (let i = 0; i < samples.length; i += size) {
    const slice = samples.slice(i, i + size);
    const cpus = slice.map((s) => pct(s.cpu_millis, s.cpu_capacity));
    const mems = slice.map((s) => pct(s.memory_bytes, s.memory_capacity));
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

    out.push({
      // L'horodatage du milieu représente mieux la tranche que son début.
      ts: slice[Math.floor(slice.length / 2)].ts,
      cpu: Math.round(avg(cpus)),
      memory: Math.round(avg(mems)),
      cpuPeak: Math.max(...cpus),
      memoryPeak: Math.max(...mems),
    });
  }
  return out;
}

/** Format d'heure adapté à la plage : les secondes n'apparaissent qu'en zoom. */
function formatTick(iso: string, minutes: number) {
  const d = new Date(iso);
  return d.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: minutes <= 15 ? "2-digit" : undefined,
  });
}

/** « 45 min », « 2 h » — repère du décalage courant. */
function formatAgo(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h} h`;
}

/** Statistiques d'une série sur la fenêtre affichée. */
function stats(values: number[]) {
  if (values.length === 0) return { min: 0, max: 0, avg: 0, last: 0, trend: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const last = values[values.length - 1];

  // Tendance : moyenne de la seconde moitié comparée à la première. Plus
  // robuste qu'un simple écart entre premier et dernier point, qui dépendrait
  // d'un pic isolé.
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half);
  const second = values.slice(half);
  const trend =
    first.length && second.length
      ? second.reduce((a, b) => a + b, 0) / second.length -
        first.reduce((a, b) => a + b, 0) / first.length
      : 0;

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(avg),
    last,
    trend: Math.round(trend),
  };
}

/**
 * Panneau d'analyse de la consommation d'un cluster.
 *
 * Les deux séries sont exprimées en pourcentage d'utilisation : une échelle
 * 0-100 commune les rend comparables sans second axe.
 */
export function UsageChart({ samples }: { samples: UsageSample[] }) {
  const [range, setRange] = React.useState<RangeKey>("1h");
  // Décalage vers le passé, en nombre de plages : 0 = maintenant, 1 = la plage
  // précédente. Permet de revoir « les 15 min d'il y a 15 min ».
  const [offset, setOffset] = React.useState(0);
  const [kind, setKind] = React.useState<ChartKind>("area");
  const [visible, setVisible] = React.useState<Record<SeriesKey, boolean>>({
    cpu: true,
    memory: true,
  });
  const [showPeaks, setShowPeaks] = React.useState(false);
  const [showAvg, setShowAvg] = React.useState(true);

  /**
   * Sélection du brush, exprimée en fraction de la fenêtre (0 → 1).
   *
   * La page se rafraîchit toutes les 5 secondes : un brush non contrôlé
   * repartirait de zéro à chaque nouveau tableau de points. Mémoriser des
   * proportions plutôt que des index garde la sélection stable même quand le
   * nombre de points change.
   */
  const [zoom, setZoom] = React.useState<{ start: number; end: number } | null>(
    null,
  );

  const minutes = RANGES.find((r) => r.key === range)!.minutes;

  const { data, from, to, empty, canGoBack, aggregated } = React.useMemo(() => {
    if (samples.length === 0) {
      return {
        data: [],
        from: null,
        to: null,
        empty: true,
        canGoBack: false,
        aggregated: false,
      };
    }

    // La fenêtre glisse depuis le dernier relevé, pas depuis l'heure courante :
    // un agent muet depuis dix minutes afficherait sinon une plage vide.
    const newest = new Date(samples[samples.length - 1].ts).getTime();
    const oldest = new Date(samples[0].ts).getTime();
    const span = minutes * 60_000;

    const end = newest - offset * span;
    const start = end - span;

    const win = samples.filter((s) => {
      const t = new Date(s.ts).getTime();
      return t >= start && t <= end;
    });

    return {
      data: bucket(win),
      from: new Date(start),
      to: new Date(end),
      empty: win.length < 2,
      canGoBack: start > oldest,
      aggregated: win.length > 140,
    };
  }, [samples, minutes, offset]);

  // Index de la sélection, recalculés depuis les fractions : le brush suit
  // ainsi la même portion de temps même si le nombre de points a bougé.
  const brushIndex = React.useMemo(() => {
    if (!zoom || data.length === 0) return null;
    const last = data.length - 1;
    const startIndex = Math.max(0, Math.min(last, Math.round(zoom.start * last)));
    const endIndex = Math.max(
      startIndex + 1,
      Math.min(last, Math.round(zoom.end * last)),
    );
    return { startIndex, endIndex };
  }, [zoom, data.length]);

  // Les statistiques portent sur ce qui est réellement affiché : zoomer sur un
  // pic doit donner les chiffres de ce pic, pas ceux de la plage entière.
  const shown = React.useMemo(
    () =>
      brushIndex
        ? data.slice(brushIndex.startIndex, brushIndex.endIndex + 1)
        : data,
    [data, brushIndex],
  );

  const cpuStats = React.useMemo(
    () => stats(shown.map((d) => d.cpu)),
    [shown],
  );
  const memStats = React.useMemo(
    () => stats(shown.map((d) => d.memory)),
    [shown],
  );

  const activeSeries = (Object.keys(chartConfig) as SeriesKey[]).filter(
    (k) => visible[k],
  );

  // Les deux panneaux pilotent la même sélection : le zoom reste synchronisé
  // entre CPU et mémoire.
  const handleBrush = React.useCallback(
    (startIndex: number, endIndex: number) => {
      const last = data.length - 1;
      if (last <= 0) return;
      // Sélection pleine largeur : on efface le zoom plutôt que de mémoriser
      // 0 → 1, pour que le bouton « toute la plage » disparaisse.
      if (startIndex <= 0 && endIndex >= last) {
        setZoom(null);
        return;
      }
      setZoom({ start: startIndex / last, end: endIndex / last });
    },
    [data.length],
  );

  return (
    <div className="rounded-xl border border-border">
      {/* ---- Barre d'outils ------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              variant={range === r.key ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={range === r.key}
              onClick={() => {
                setRange(r.key);
                // Changer de plage remet au présent : conserver le décalage
                // renverrait vers une fenêtre arbitraire.
                setOffset(0);
                setZoom(null);
              }}
            >
              {r.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {/* Navigation temporelle */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Plage précédente"
            title="Plage précédente"
            disabled={!canGoBack}
            onClick={() => {
              setOffset((o) => o + 1);
              setZoom(null);
            }}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Plage suivante"
            title="Plage suivante"
            disabled={offset === 0}
            onClick={() => {
              setOffset((o) => Math.max(0, o - 1));
              setZoom(null);
            }}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          {offset > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setOffset(0);
                setZoom(null);
              }}
            >
              <RotateCcw className="size-3" />
              Maintenant
            </Button>
          )}

          <Separator orientation="vertical" className="mx-1 h-5" />

          {/* Type de graphique */}
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {(
              [
                ["area", AreaIcon, "Aires"],
                ["line", LineIcon, "Lignes"],
                ["bar", BarChart3, "Barres"],
              ] as const
            ).map(([k, Icon, label]) => (
              <Button
                key={k}
                variant={kind === k ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={label}
                aria-pressed={kind === k}
                title={label}
                onClick={() => setKind(k)}
              >
                <Icon className="size-3" />
              </Button>
            ))}
          </div>

          {/* Options d'affichage */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="Options" />
              }
            >
              <Maximize2 className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-muted-foreground">
                  Séries
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              {(Object.keys(chartConfig) as SeriesKey[]).map((k) => (
                <DropdownMenuCheckboxItem
                  key={k}
                  checked={visible[k]}
                  // Masquer la dernière série laisserait un graphe vide.
                  disabled={visible[k] && activeSeries.length === 1}
                  onCheckedChange={(v) =>
                    setVisible((s) => ({ ...s, [k]: Boolean(v) }))
                  }
                >
                  {chartConfig[k].label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-muted-foreground">
                  Repères
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuCheckboxItem
                checked={showAvg}
                onCheckedChange={(v) => setShowAvg(Boolean(v))}
              >
                Ligne de moyenne
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showPeaks}
                disabled={!aggregated}
                onCheckedChange={(v) => setShowPeaks(Boolean(v))}
              >
                Pics par tranche
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ---- Fenêtre courante + synthèse ------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 pt-3">
        {from && to && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular">
              {from.toLocaleString("fr-FR", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {" → "}
              {to.toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {offset === 0 ? (
              <Badge
                variant="secondary"
                className="gap-1 border-transparent bg-success/12 text-success"
              >
                <Activity className="size-3" />
                en direct
              </Badge>
            ) : (
              <Badge variant="outline">
                il y a {formatAgo(offset * minutes)}
              </Badge>
            )}
            {aggregated && (
              <Badge variant="outline" title="Points moyennés pour la lisibilité">
                agrégé
              </Badge>
            )}
            {brushIndex && (
              <Button variant="ghost" size="xs" onClick={() => setZoom(null)}>
                <RotateCcw className="size-3" />
                Toute la plage
              </Button>
            )}
          </p>
        )}
      </div>

      {empty ? (
        <div className="p-3">
          <p className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-xs text-muted-foreground">
            {samples.length === 0
              ? "Historique en cours de constitution — la courbe apparaîtra après quelques relevés."
              : "Aucun relevé sur cette plage."}
          </p>
        </div>
      ) : (
        /* Une série par graphique : superposées, CPU et mémoire se masquaient
           mutuellement dès qu'elles évoluaient dans la même zone. */
        <div className="divide-y divide-border">
          {visible.cpu && (
            <SeriesPanel
              seriesKey="cpu"
              data={data}
              minutes={minutes}
              kind={kind}
              stats={cpuStats}
              showAvg={showAvg}
              showPeaks={showPeaks && aggregated}
              brushIndex={brushIndex}
              onBrush={handleBrush}
            />
          )}
          {visible.memory && (
            <SeriesPanel
              seriesKey="memory"
              data={data}
              minutes={minutes}
              kind={kind}
              stats={memStats}
              showAvg={showAvg}
              showPeaks={showPeaks && aggregated}
              brushIndex={brushIndex}
              onBrush={handleBrush}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Un graphique et ses chiffres clés, pour une seule série.
 *
 * Le brush n'est rendu que sur le dernier panneau visible : dupliqué, il
 * occuperait deux fois la hauteur pour piloter la même sélection.
 */
function SeriesPanel({
  seriesKey,
  data,
  minutes,
  kind,
  stats: s,
  showAvg,
  showPeaks,
  brushIndex,
  onBrush,
}: {
  seriesKey: SeriesKey;
  data: Point[];
  minutes: number;
  kind: ChartKind;
  stats: ReturnType<typeof stats>;
  showAvg: boolean;
  showPeaks: boolean;
  brushIndex: { startIndex: number; endIndex: number } | null;
  onBrush: (startIndex: number, endIndex: number) => void;
}) {
  const config = chartConfig[seriesKey];
  const single = { [seriesKey]: config } as ChartConfig;

  return (
    <div className="p-3">
      <SeriesSummary label={config.label} color={config.color} s={s} />

      <div className="mt-3">
        <ChartContainer config={single} className="aspect-auto h-44 w-full">
          <ChartBody
            seriesKey={seriesKey}
            kind={kind}
            data={data}
            minutes={minutes}
            showPeaks={showPeaks}
            showAvg={showAvg}
            avg={s.avg}
            brushIndex={brushIndex}
            onBrush={onBrush}
          />
        </ChartContainer>
      </div>
    </div>
  );
}

/** Chiffres clés d'une série sur la fenêtre affichée. */
function SeriesSummary({
  label,
  color,
  s,
}: {
  label: string;
  color: string;
  s: ReturnType<typeof stats>;
}) {
  const Trend =
    s.trend > 2 ? ArrowUpRight : s.trend < -2 ? ArrowDownRight : ArrowRight;
  const trendTone =
    s.trend > 2
      ? "text-warning"
      : s.trend < -2
        ? "text-success"
        : "text-muted-foreground";

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          {label}
        </span>
        <span
          className={cn("flex items-center gap-1 text-xs tabular", trendTone)}
          title="Tendance sur la fenêtre affichée"
        >
          <Trend className="size-3" />
          {s.trend > 0 ? "+" : ""}
          {s.trend} pt
        </span>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
        <Metric label="actuel" value={s.last} strong />
        <Metric label="moy." value={s.avg} />
        <Metric label="min" value={s.min} />
        <Metric label="max" value={s.max} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div>
      <p
        className={cn(
          "tabular",
          strong ? "text-base font-semibold" : "text-sm font-medium",
        )}
      >
        {value}%
      </p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

type Point = ReturnType<typeof bucket>[number];

/**
 * Corps du graphique.
 *
 * Recharts exige un enfant unique dans `ChartContainer` : le type choisi est
 * rendu ici plutôt que par une condition dans le parent.
 */
function ChartBody({
  seriesKey,
  kind,
  data,
  minutes,
  showPeaks,
  showAvg,
  avg,
  brushIndex,
  onBrush,
}: {
  seriesKey: SeriesKey;
  kind: ChartKind;
  data: Point[];
  minutes: number;
  showPeaks: boolean;
  showAvg: boolean;
  avg: number;
  brushIndex: { startIndex: number; endIndex: number } | null;
  onBrush: (startIndex: number, endIndex: number) => void;
}) {
  const color = `var(--color-${seriesKey})`;
  const peakKey = seriesKey === "cpu" ? "cpuPeak" : "memoryPeak";
  const axes = (
    <>
      <CartesianGrid vertical={false} strokeDasharray="3 3" />
      <XAxis
        dataKey="ts"
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={40}
        tickFormatter={(v) => formatTick(v, minutes)}
      />
      <YAxis
        domain={[0, 100]}
        ticks={[0, 50, 100]}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        width={36}
        tickFormatter={(v) => `${v}%`}
      />
      <ChartTooltip
        content={
          <ChartTooltipContent
            labelFormatter={(v) =>
              new Date(v as string).toLocaleString("fr-FR", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })
            }
            formatter={(value, name) => (
              <div className="flex w-full items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {name === peakKey
                    ? "pic"
                    : (chartConfig[name as SeriesKey]?.label ?? name)}
                </span>
                <span className="font-mono font-medium tabular">{value}%</span>
              </div>
            )}
          />
        }
      />

      {/* Repère de moyenne : situe la charge courante par rapport à
          l'ordinaire de la fenêtre. */}
      {showAvg && (
        <ReferenceLine
          y={avg}
          stroke={color}
          strokeDasharray="4 4"
          strokeOpacity={0.5}
        />
      )}
    </>
  );

  // Le brush n'a d'intérêt qu'avec de quoi resserrer la sélection.
  const brush =
    data.length > 8 ? (
      <Brush
        dataKey="ts"
        height={24}
        travellerWidth={10}
        stroke="var(--border)"
        fill="var(--muted)"
        startIndex={brushIndex?.startIndex ?? 0}
        endIndex={brushIndex?.endIndex ?? data.length - 1}
        onChange={(r) => {
          const { startIndex, endIndex } = r as {
            startIndex?: number;
            endIndex?: number;
          };
          if (startIndex === undefined || endIndex === undefined) return;
          onBrush(startIndex, endIndex);
        }}
        tickFormatter={(v) => formatTick(v as string, minutes)}
      />
    ) : null;

  const peak = showPeaks ? (
    <Line
      dataKey={peakKey}
      type="monotone"
      stroke={color}
      strokeWidth={1}
      strokeDasharray="3 3"
      strokeOpacity={0.6}
      dot={false}
      isAnimationActive={false}
    />
  ) : null;

  if (kind === "bar") {
    return (
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        {axes}
        <Bar
          dataKey={seriesKey}
          fill={color}
          radius={2}
          isAnimationActive={false}
        />
        {brush}
      </BarChart>
    );
  }

  if (kind === "line") {
    return (
      <LineChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        {axes}
        <Line
          dataKey={seriesKey}
          type="monotone"
          stroke={color}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        {peak}
        {brush}
      </LineChart>
    );
  }

  return (
    <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
      <defs>
        {/* Dégradé sous la courbe : la lecture des creux et des pics est plus
            immédiate qu'avec un simple trait. */}
        <linearGradient id={`fill-${seriesKey}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor={color} stopOpacity={0.35} />
          <stop offset="95%" stopColor={color} stopOpacity={0.03} />
        </linearGradient>
      </defs>
      {axes}
      <Area
        dataKey={seriesKey}
        type="monotone"
        stroke={color}
        fill={`url(#fill-${seriesKey})`}
        strokeWidth={2}
        dot={false}
        isAnimationActive={false}
      />
      {peak}
      {brush}
    </AreaChart>
  );
}
