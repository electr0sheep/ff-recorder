enum TimelineSegmentType {
  BossEncounter = 'Boss',
  Trash = 'Trash',
}

type RawDungeonTimelineSegment = {
  segmentType?: TimelineSegmentType;
  logStart?: string;
  timestamp?: number;
  encounterId?: number;
  logEnd?: string;
  result?: string;
  name?: string; // Boss name, used by FFXIV segments which have no encounterId.
};

class DungeonTimelineSegment {
  logEnd: Date;

  result?: boolean;

  constructor(
    public segmentType: TimelineSegmentType,
    public logStart: Date,
    public timestamp: number,
    public encounterId?: number,
    public name?: string,
  ) {
    // Initially, let's set this to log start date to avoid logEnd
    // potentially being undefined.
    this.logEnd = logStart;
  }

  length(): number {
    return this.logEnd.getTime() - this.logStart.getTime();
  }

  getRaw(): RawDungeonTimelineSegment {
    const rawSegment: RawDungeonTimelineSegment = {
      segmentType: this.segmentType,
      logStart: this.logStart.toISOString(),
      logEnd: this.logEnd.toISOString(),
      timestamp: this.timestamp,
    };

    if (this.encounterId !== undefined) {
      rawSegment.encounterId = this.encounterId;
    }

    if (this.name !== undefined) {
      rawSegment.name = this.name;
    }

    return rawSegment;
  }
}

// The WoW code (and upstream) still use the challenge mode names; the
// dungeon names are shared with FFXIV. Both name the same things.
type RawChallengeModeTimelineSegment = RawDungeonTimelineSegment;
const ChallengeModeTimelineSegment = DungeonTimelineSegment;
type ChallengeModeTimelineSegment = DungeonTimelineSegment;

export {
  TimelineSegmentType,
  DungeonTimelineSegment,
  RawDungeonTimelineSegment,
  ChallengeModeTimelineSegment,
  RawChallengeModeTimelineSegment,
};
