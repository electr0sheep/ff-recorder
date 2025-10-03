import { ConfigurationSchema } from 'config/configSchema';
import React from 'react';
import { AppState } from 'main/types';
import { getLocalePhrase } from 'localisation/translations';
import { setConfigValues, useSettings } from './useSettings';
import Switch from './components/Switch/Switch';
import Label from './components/Label/Label';
import { Phrase } from 'localisation/phrases';

interface IProps {
  appState: AppState;
}

const FFXIVSettings = (props: IProps) => {
  const { appState } = props;
  const [config, setConfig] = useSettings();
  const initialRender = React.useRef(true);

  React.useEffect(() => {
    // Don't fire on the initial render.
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }

    setConfigValues({
      FFXIVRecordDungeons: config.FFXIVRecordDungeons,
      FFXIVRecordTrials: config.FFXIVRecordTrials,
      FFXIVRecordRaids: config.FFXIVRecordRaids,
      FFXIVRecordAllianceRaids: config.FFXIVRecordAllianceRaids,
    });
  }, [
    config.FFXIVRecordDungeons,
    config.FFXIVRecordTrials,
    config.FFXIVRecordRaids,
    config.FFXIVRecordAllianceRaids,
  ]);

  const getSwitch = (
    preference: keyof ConfigurationSchema,
    changeFn: (checked: boolean) => void,
  ) => (
    <Switch
      checked={Boolean(config[preference])}
      name={preference}
      onCheckedChange={changeFn}
    />
  );

  const getSwitchForm = (
    preference: keyof ConfigurationSchema,
    label: Phrase,
    changeFn: (checked: boolean) => void,
  ) => {
    return (
      <div className="flex flex-col w-[140px]">
        <Label htmlFor={preference} className="flex items-center">
          {getLocalePhrase(appState.language, label)}
        </Label>
        <div className="flex h-10 items-center">
          {getSwitch(preference, changeFn)}
        </div>
      </div>
    );
  };

  const setRecordDungeons = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordDungeons: checked,
      };
    });
  };

  const setRecordTrials = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordTrials: checked,
      };
    });
  };

  const setRecordRaids = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordRaids: checked,
      };
    });
  };

  const setRecordAllianceRaids = (checked: boolean) => {
    setConfig((prevState) => {
      return {
        ...prevState,
        FFXIVRecordAllianceRaids: checked,
      };
    });
  };

  return (
    <div className="flex flex-row flex-wrap gap-x-4">
      {getSwitchForm(
        'FFXIVRecordDungeons',
        Phrase.FFXIVRecordDungeons,
        setRecordDungeons,
      )}
      {getSwitchForm('FFXIVRecordTrials', Phrase.FFXIVRecordTrials, setRecordTrials)}
      {getSwitchForm('FFXIVRecordRaids', Phrase.FFXIVRecordRaids, setRecordRaids)}
      {getSwitchForm(
        'FFXIVRecordAllianceRaids',
        Phrase.FFXIVRecordAllianceRaids,
        setRecordAllianceRaids,
      )}
    </div>
  );
};

export default FFXIVSettings;
