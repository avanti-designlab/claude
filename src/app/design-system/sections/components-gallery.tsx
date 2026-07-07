"use client";

/**
 * The shadcn/ui working set, re-pointed at the token system. Copy follows
 * doc 06 §6: name what the user controls, sentence case, plain verbs, and an
 * action keeps its name through the flow ("Publish" → "Published").
 * Overlay components (dialog, sheet, menus, toasts) portal to <body> and are
 * still tenant-themed because the theme applies at :root.
 */

import * as React from "react";
import { ChevronDownIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Section, SpecimenPanel } from "./section";

const PENDING_CHANGES = [
  { page: "/neighborhood-guides/north-park", change: "Add FAQPage schema", level: "ai-draft", status: "Pending review" },
  { page: "/agents/maria-castillo", change: "Add Person schema + sameAs", level: "auto", status: "Approved" },
  { page: "/blog/2026-market-report", change: "Refresh stale citations", level: "ai-draft", status: "Pending review" },
  { page: "/listings", change: "Fix render-blocking hero", level: "human-only", status: "Draft" },
] as const;

export function ComponentsGallery() {
  const [progress, setProgress] = React.useState(64);

  return (
    <Section
      id="components"
      overline="03 · Components"
      title="The working set"
      description="22 shadcn/ui components, every one themed through the token layer. Dense surfaces (tables, forms) stay quiet by design — no motion here."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <SpecimenPanel label="Buttons — actions keep their names">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Publish blog</Button>
            <Button variant="secondary">Save draft</Button>
            <Button variant="outline">Preview diff</Button>
            <Button variant="ghost">Dismiss</Button>
            <Button variant="destructive">
              <RotateCcwIcon aria-hidden /> Revert change
            </Button>
            <Button disabled>Awaiting review</Button>
            <Button size="sm" variant="outline">
              Small
            </Button>
          </div>
        </SpecimenPanel>

        <SpecimenPanel label="Badges — automation levels & statuses">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>ai-draft</Badge>
            <Badge variant="secondary">auto</Badge>
            <Badge variant="outline">human-only</Badge>
            <Badge className="bg-positive text-positive-foreground">Cited</Badge>
            <Badge variant="destructive">Compliance hold</Badge>
          </div>
        </SpecimenPanel>

        <SpecimenPanel label="Form controls — quiet, legible, no flourish">
          <form className="flex flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
            <div className="grid gap-2">
              <Label htmlFor="ds-client-name">Client name</Label>
              <Input id="ds-client-name" placeholder="Harborline Realty" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ds-vertical">Vertical</Label>
              <Select defaultValue="real-estate">
                <SelectTrigger id="ds-vertical" className="w-full">
                  <SelectValue placeholder="Select a vertical" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="real-estate">Real estate</SelectItem>
                  <SelectItem value="cannabis">Cannabis</SelectItem>
                  <SelectItem value="restaurants">Restaurants</SelectItem>
                  <SelectItem value="insurance">Health & life insurance</SelectItem>
                  <SelectItem value="ecommerce">Ecommerce</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ds-voice-note">Voice note</Label>
              <Textarea
                id="ds-voice-note"
                placeholder="Confident, neighborly, never salesy."
                rows={2}
              />
            </div>
            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2 text-sm text-ink">
                <Checkbox defaultChecked /> Require human approval
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <Switch defaultChecked /> Weekly tracker runs
              </label>
            </div>
          </form>
        </SpecimenPanel>

        <SpecimenPanel label="Overlays — portal to <body>, still tenant-themed">
          <div className="flex flex-wrap items-center gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Approve change…</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Approve this change?</DialogTitle>
                  <DialogDescription>
                    Adds FAQPage schema to /neighborhood-guides/north-park. The
                    change is logged and reversible in one click.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost">Cancel</Button>
                  <Button onClick={() => toast.success("Change approved", { description: "Queued for the next publish window." })}>
                    Approve change
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open change log</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Change log</SheetTitle>
                  <SheetDescription>
                    Every site write, with its diff and a one-click revert.
                  </SheetDescription>
                </SheetHeader>
                <div className="flex flex-col gap-3 px-4">
                  {PENDING_CHANGES.map((change) => (
                    <div key={change.page} className="rounded-md border p-3">
                      <p className="font-mono text-xs text-muted">{change.page}</p>
                      <p className="mt-1 text-sm text-ink">{change.change}</p>
                    </div>
                  ))}
                </div>
              </SheetContent>
            </Sheet>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  Actions <ChevronDownIcon aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>This page</DropdownMenuLabel>
                <DropdownMenuItem>Preview diff</DropdownMenuItem>
                <DropdownMenuItem>Re-run audit</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">Revert change</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Connected via edge worker">
                    <GitBranchIcon aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Connected via Cloudflare edge worker</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <Button
              variant="secondary"
              onClick={() =>
                toast("Published", { description: "Q3 market report is live." })
              }
            >
              Publish → toast
            </Button>
          </div>
        </SpecimenPanel>
      </div>

      <SpecimenPanel label="Data table — the auto-fix changes view stays utilitarian (doc 06 §5)">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Automation</TableHead>
              <TableHead className="text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PENDING_CHANGES.map((change) => (
              <TableRow key={change.page}>
                <TableCell className="font-mono text-xs text-muted">{change.page}</TableCell>
                <TableCell className="text-ink">{change.change}</TableCell>
                <TableCell>
                  <Badge variant={change.level === "auto" ? "secondary" : "outline"}>
                    {change.level}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-muted">{change.status}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SpecimenPanel>

      <div className="grid gap-6 lg:grid-cols-2">
        <SpecimenPanel label="Structure — tabs, breadcrumb, separator">
          <div className="flex flex-col gap-5">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink href="#components">Clients</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink href="#components">Harborline Realty</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>Visibility</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <Separator />
            <Tabs defaultValue="visibility">
              <TabsList>
                <TabsTrigger value="visibility">Visibility</TabsTrigger>
                <TabsTrigger value="content">Content</TabsTrigger>
                <TabsTrigger value="changes">Changes</TabsTrigger>
              </TabsList>
              <TabsContent value="visibility" className="pt-3 text-sm text-muted">
                Score, trend, and per-engine citations for this client.
              </TabsContent>
              <TabsContent value="content" className="pt-3 text-sm text-muted">
                The pipeline: generate → humanize → review → publish.
              </TabsContent>
              <TabsContent value="changes" className="pt-3 text-sm text-muted">
                Pending diffs and the applied-change log.
              </TabsContent>
            </Tabs>
          </div>
        </SpecimenPanel>

        <SpecimenPanel label="Status — avatar, progress, skeleton, scroll area">
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <Avatar>
                <AvatarFallback>HR</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">Harborline Realty</p>
                <p className="font-mono text-xs text-muted">real-estate · 3 locations</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Progress value={progress} className="flex-1" aria-label="Pipeline progress" />
              <span className="font-mono text-xs text-muted">{progress}%</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setProgress((value) => (value >= 100 ? 24 : value + 12))}
              >
                Advance
              </Button>
            </div>
            <div className="flex flex-col gap-2" aria-hidden>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
            <ScrollArea className="h-24 rounded-md border p-3">
              <p className="text-sm leading-6 text-muted">
                Work-done log — the retention weapon. Added FAQPage schema to 12
                neighborhood guides. Refreshed 4 stale market stats. Published the
                Q3 market report. Fixed render-blocking hero on /listings. Claimed
                and deduplicated 3 GBP locations. Drafted 6 review responses for
                approval. Re-ran the tracker across 6 engines.
              </p>
            </ScrollArea>
          </div>
        </SpecimenPanel>
      </div>
    </Section>
  );
}
