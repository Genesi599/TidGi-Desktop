import { Alert, LinearProgress, Snackbar, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

import type { ITiddlyWebWikiFormValues } from './TiddlyWebWikiForm';
import { CloseButton, ReportErrorFabButton, WikiLocation } from './FormComponents';
import type { IWikiWorkspaceFormProps } from './useForm';
import { useTiddlyWebWiki, useValidateTiddlyWebWiki } from './useTiddlyWebWiki';
import { useWikiCreationProgress } from './useIndicator';

export function TiddlyWebWikiDoneButton(
  { form, errorInWhichComponentSetter, tiddlywebForm }: IWikiWorkspaceFormProps & { tiddlywebForm: ITiddlyWebWikiFormValues },
): React.JSX.Element {
  const { t } = useTranslation();
  const [hasError, wikiCreationMessage, wikiCreationMessageSetter, hasErrorSetter] = useValidateTiddlyWebWiki(
    form,
    tiddlywebForm,
    errorInWhichComponentSetter,
  );
  const onSubmit = useTiddlyWebWiki(form, tiddlywebForm, wikiCreationMessageSetter, hasErrorSetter);
  const [logPanelOpened, logPanelSetter, inProgressOrError] = useWikiCreationProgress(
    wikiCreationMessageSetter,
    wikiCreationMessage,
    hasError,
  );

  if (hasError) {
    return (
      <>
        <CloseButton variant='contained' disabled>
          {wikiCreationMessage}
        </CloseButton>
        {wikiCreationMessage !== undefined && <ReportErrorFabButton message={wikiCreationMessage} />}
      </>
    );
  }
  return (
    <>
      {inProgressOrError && <LinearProgress color='secondary' />}
      <Snackbar
        open={logPanelOpened}
        autoHideDuration={5000}
        onClose={() => {
          logPanelSetter(false);
        }}
      >
        <Alert severity='info'>{wikiCreationMessage}</Alert>
      </Snackbar>
      <CloseButton variant='contained' color='secondary' disabled={inProgressOrError} onClick={onSubmit}>
        <Typography variant='body1' display='inline'>
          {t('AddWorkspace.TiddlyWebCloneWiki')}
        </Typography>
        <WikiLocation>{form.wikiFolderLocation}</WikiLocation>
      </CloseButton>
    </>
  );
}
