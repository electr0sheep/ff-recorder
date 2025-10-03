
import Battleground from 'activitys/Battleground';
import FFXIVGenericLogHandler from './FFXIVGenericLogHandler';
import FFXIVLogLine from './FFXIVLogLine';
import { VideoCategory } from 'types/VideoCategory';
import { Flavour } from 'main/types';
import Combatant from 'main/Combatant';

/**
 * FFXIVLogHandler class.
 */
export default class FFXIVLogHandler extends FFXIVGenericLogHandler {
  constructor(logPath: string) {
    console.debug('[FFXIVLogHandler] starting');
    super(logPath, 10);

    this.combatLogWatcher.on('265', async (line: FFXIVLogLine) => {
      await this.handleZoneChange(line);
    });
  }

  private async handleZoneChange(line: FFXIVLogLine) {
    const zone = line.arg(3);
    // console.debug('[FFXIVLogHandler] Handling test:', line.arg(3));
    if (zone == "Thok ast Thok (Hard)") {
      const activity = new Battleground(
        line.date(),
        VideoCategory.Battlegrounds,
        5,
        Flavour.Retail,
      );

      activity.playerGUID = '12345';
      activity.addCombatant(new Combatant('12345'));

      await FFXIVGenericLogHandler.startActivity(activity);
    } else {
      if (FFXIVGenericLogHandler.activity) {
        FFXIVGenericLogHandler.activity.end(line.date(), false);
        await FFXIVGenericLogHandler.endActivity();
      }
    }
  }
}
