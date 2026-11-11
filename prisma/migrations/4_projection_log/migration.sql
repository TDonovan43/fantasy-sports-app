-- CreateTable
CREATE TABLE "ProjectionLog" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "playerKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "opponent" TEXT,
    "gameId" TEXT,
    "kickoff" TEXT,
    "salary" INTEGER NOT NULL,
    "projected" DOUBLE PRECISION NOT NULL,
    "floor" DOUBLE PRECISION NOT NULL,
    "ceiling" DOUBLE PRECISION NOT NULL,
    "injury" TEXT,
    "source" TEXT NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectionLog_season_week_idx" ON "ProjectionLog"("season", "week");

