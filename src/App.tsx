// /* eslint-disable react-hooks/exhaustive-deps */
import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { EnhancedTextarea } from './EnhancedTextarea';
import LZString from 'lz-string';
import Fuse from 'fuse.js';
import AceEditor from 'react-ace';

// Updated textsToReplace with additional text replacements for enhanced text processing
const textsToReplace: [string | RegExp, string][] = [
  [' -> ', ' → '],
  [' <- ', ' ← '],
  ['\n-> ', '\n→ '],
  ['<- \n', '← \n'],
  [/^-> /, '→ '],
  [/^<- /, '← '],
  ['(c)', '©'],
  ['(r)', '®'],
  ['+-', '±'],
];

function usePersistentState<T>(storageKey: string, defaultValue?: T) {
  const [data, setData] = useState<T>(() => {
    const localStorageData = localStorage.getItem(storageKey);

    try {
      return localStorageData ? JSON.parse(localStorageData) : defaultValue;
    } catch (e) {
      console.error('Failed to parse local storage data', e);
      return defaultValue;
    }
  });

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === storageKey) {
        setData(event.newValue ? JSON.parse(event.newValue) : defaultValue);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [storageKey, defaultValue]);

  return [
    data,
    (newData: T) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(newData));
        setData(newData);
      } catch (e) {
        console.error('Failed to save data to local storage', e);
      }
    },
  ] as const;
}

const getRandomId = () => Math.random().toString(36).substring(2);

type Note = {
  id: string;
  content: string;
  updatedAt: string;
  workspace?: string;
};

type CmdKSuggestion =
  | {
      type: 'note';
      note: Note;
    }
  | {
      type: 'action';
      title: string;
      content: string;
      color?: string;
      // return true to close the cmd-k menu
      onAction: () => boolean;
    };

const cmdKSuggestionActionType = 'action' as const;

const freshDatabase = [
  {
    id: getRandomId(),
    content: '',
    updatedAt: new Date().toISOString(),
  },
];

async function backupDataToSafeLocation(data: unknown) {
  if (!('indexedDB' in window)) {
    console.error("This browser doesn't support IndexedDB");
    return;
  }

  const dbRequest = indexedDB.open('BackupDatabase', 1);

  dbRequest.onupgradeneeded = (event) => {
    const db = (event.target as IDBOpenDBRequest).result;
    if (!db.objectStoreNames.contains('backups')) {
      db.createObjectStore('backups', { autoIncrement: true });
    }
  };

  dbRequest.onerror = (event) => {
    console.error('Error opening IndexedDB for backup', event);
  };

  dbRequest.onsuccess = (event) => {
    const db = (event.target as IDBOpenDBRequest).result;
    const transaction = db.transaction('backups', 'readwrite');
    const store = transaction.objectStore('backups');
    const request = store.add({ date: new Date().toISOString(), data });

    request.onsuccess = () => {
      console.log('Data backed up successfully in IndexedDB');
    };

    request.onerror = (event) => {
      console.error('Error backing up data in IndexedDB', event);
    };
  };
}

function usePeriodicBackup<T>(data: T, interval: number = 24 * 60 * 60 * 1000) {
  useEffect(() => {
    const lastBackupDateStr = localStorage.getItem('lastBackupDate');
    const lastBackupDate = lastBackupDateStr
      ? new Date(lastBackupDateStr)
      : new Date(0);
    const now = new Date();

    if (now.getTime() - lastBackupDate.getTime() > interval) {
      backupDataToSafeLocation(data);
      localStorage.setItem('lastBackupDate', now.toISOString());
    }

    const intervalId = setInterval(() => {
      backupDataToSafeLocation(data);
      localStorage.setItem('lastBackupDate', new Date().toISOString());
    }, interval);

    return () => clearInterval(intervalId);
  }, [data, interval]);
}

const themeId = 'typehere-theme';
if (localStorage.getItem(themeId) === '"dark"') {
  document.documentElement.setAttribute('data-theme', 'dark');
}

const sortNotes = (notes: Note[]) => {
  return notes.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
};

function App() {
  const textareaDomRef = useRef<HTMLTextAreaElement>(null);

  const [database, setDatabase] = usePersistentState<Note[]>(
    'typehere-database',
    freshDatabase,
  );

  usePeriodicBackup(database);

  const [currentWorkspace, setCurrentWorkspace] = usePersistentState<
    string | null
  >('typehere-currentWorkspace', null);
  const [currentNoteId, setCurrentNoteId] = usePersistentState<string>(
    'typehere-currentNoteId',
    freshDatabase[0].id,
  );
  const [moreMenuPosition, setMoreMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [isHelpMenuOpen, setIsHelpMenuOpen] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [lastAceCursorPosition, setLastAceCursorPosition] = useState({
    row: 0,
    column: 0,
  });

  const workspaceNotes = useMemo(() => {
    return currentWorkspace === null
      ? database
      : database.filter((n) => n.workspace === currentWorkspace);
  }, [database, currentWorkspace]);

  const availableWorkspaces = useMemo(() => {
    const seenWorkspaces = new Set<string>();
    const allWorkspaces: string[] = [];
    const shallowDatabase = sortNotes([...database]);

    for (const note of shallowDatabase) {
      if (!note.workspace || seenWorkspaces.has(note.workspace)) {
        continue;
      }

      allWorkspaces.push(note.workspace);
      seenWorkspaces.add(note.workspace);
    }

    return allWorkspaces;
  }, [database]);

  const navigableWorkspaces = useMemo(() => {
    return [null, ...availableWorkspaces];
  }, [availableWorkspaces]);

  useEffect(() => {
    const currentNote = workspaceNotes.find(
      (note) => note.id === currentNoteId,
    );
    if (currentNote) {
      setTextValue(currentNote.content);
    } else {
      setCurrentNoteId(workspaceNotes[0].id);
      setTextValue(workspaceNotes[0].content);
    }
  }, [currentNoteId, workspaceNotes, setCurrentNoteId]);

  const focus = () => {
    if (aceEditorRef.current) {
      const editor = aceEditorRef.current.editor;
      if (editor.isFocused()) return;
      editor.moveCursorTo(
        lastAceCursorPosition.row,
        lastAceCursorPosition.column,
      );
      editor.focus();
    } else {
      textareaDomRef.current?.focus();
    }
  };

  const deleteNote = (noteId: string) => {
    const deletedNote = database.find((note) => note.id === noteId);
    if (!deletedNote) return;
    setFreshlyDeletedNotes((prev) => [...prev, deletedNote]);
    const updatedDatabase = database.filter((note) => note.id !== noteId);
    setDatabase(updatedDatabase);
    if (currentNoteId === noteId) {
      setCurrentNoteId(updatedDatabase[0]?.id || '');
      setTextValue(updatedDatabase[0]?.content || '');
    }
  };

  const openNote = (noteId: string) => {
    if (!noteId || !database.find((n) => n.id === noteId)) {
      return;
    }

    setLastAceCursorPosition({ row: 0, column: 0 });
    setCurrentNoteId(noteId);

    const n = database.find((n) => n.id === noteId);
    if (n) {
      n.updatedAt = new Date().toISOString();
    }

    setDatabase(database);

    setTimeout(() => {
      focus();

      if (aceEditorRef.current) {
        const editor = aceEditorRef.current.editor;
        editor.getSession().getUndoManager().reset();
        editor.clearSelection();
        editor.moveCursorTo(0, 0);
      }
    }, 10);
  };

  const openNewNote = (
    defaultContent: string = '',
    defaultWorkspace: string = '',
  ) => {
    const newNote: Note = {
      id: getRandomId(),
      content: defaultContent,
      updatedAt: new Date().toISOString(),
      workspace: (defaultWorkspace || currentWorkspace) ?? undefined,
    };

    setDatabase([...database, newNote]);
    setCurrentNoteId(newNote.id);
    setTextValue('');
    openNote(newNote.id);

    return newNote;
  };

  const fileInputDomRef = useRef<HTMLInputElement>(null);

  const [currentTheme, setCurrentTheme] = usePersistentState<'light' | 'dark'>(
    themeId,
    'light',
  );
  const [selectedCmdKSuggestionIndex, setSelectedCmdKSuggestionIndex] =
    useState<number>(0);
  const [cmdKSearchQuery, setCmdKSearchQuery] = useState('');
  const [isCmdKMenuOpen, setIsCmdKMenuOpen] = useState(false);
  const [hasVimNavigated, setHasVimNavigated] = useState(false);
  const [isUsingVim, setIsUsingVim] = usePersistentState('typehere-vim', false);
  const [isNarrowScreen, setIsNarrowScreen] = usePersistentState(
    'typehere-narrow',
    false,
  );
  const [freshlyDeletedNotes, setFreshlyDeletedNotes] = useState<Note[]>([]);

  const toggleTheme = () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    saveTheme(newTheme);
  };

  const saveTheme = (theme: 'light' | 'dark') => {
    setCurrentTheme(theme);
    document.documentElement.setAttribute('data-theme', theme);
  };

  useEffect(() => {
    if (currentTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }, [currentTheme]);

  const cmdKSuggestions = useMemo<CmdKSuggestion[]>(() => {
    const notesFuse = new Fuse(workspaceNotes, {
      keys: ['content'],
      includeScore: true,
      threshold: 0.3,
    });
    const workspaceFuse = new Fuse(availableWorkspaces, {
      includeScore: true,
      threshold: 0.05, // lower for workspace match
    });
    const notes = cmdKSearchQuery
      ? notesFuse.search(cmdKSearchQuery).map((result) => result.item)
      : workspaceNotes;
    const workspaces = cmdKSearchQuery
      ? workspaceFuse.search(cmdKSearchQuery).map((result) => result.item)
      : [];
    const currentNote = database.find((note) => note.id === currentNoteId);

    const trimmedCmdKQuery = cmdKSearchQuery.trim().slice(0, 20);
    const unlinkTitle = 'unlink note';

    const actions: CmdKSuggestion[] = [
      ...(trimmedCmdKQuery
        ? [
            {
              type: cmdKSuggestionActionType,
              title: 'create new note',
              content: `"${trimmedCmdKQuery}"`,
              color: 'green',
              onAction: () => {
                openNewNote(trimmedCmdKQuery);
                setIsCmdKMenuOpen(false);
                setSelectedCmdKSuggestionIndex(0);
                setCmdKSearchQuery('');
                return true;
              },
            },
            ...(workspaces.length > 0
              ? [
                  {
                    type: cmdKSuggestionActionType,
                    title: `move note to ${workspaces[0]}`,
                    content: `→[${workspaces[0]}]`,
                    color: 'cyan',
                    onAction() {
                      if (!currentNote) {
                        console.warn('weird weird weird');
                        return true;
                      }
                      currentNote.workspace = workspaces[0] ?? undefined;
                      setDatabase(database);
                      setCurrentWorkspace(workspaces[0]);
                      setSelectedCmdKSuggestionIndex(0);
                      openNote(currentNote.id);
                      setCmdKSearchQuery('');
                      return false;
                    },
                  },
                ]
              : []),

            ...(availableWorkspaces.find(
              (workspace) => workspace === trimmedCmdKQuery,
            )
              ? currentWorkspace
                ? []
                : []
              : [
                  {
                    type: cmdKSuggestionActionType,
                    title: 'create workspace',
                    color: 'red',
                    content: `+[${trimmedCmdKQuery}]`,
                    onAction: () => {
                      openNewNote('', trimmedCmdKQuery);
                      setSelectedCmdKSuggestionIndex(0);
                      setCurrentWorkspace(trimmedCmdKQuery);
                      setCmdKSearchQuery('');
                      return false;
                    },
                  },
                ]),
            {
              type: cmdKSuggestionActionType,
              title: 'rename workspace',
              content: `±[${trimmedCmdKQuery}]`,
              color: 'gray',
              onAction: () => {
                const newDatabase = [...database].map((n) => {
                  if (n.workspace !== currentWorkspace) {
                    return n;
                  }
                  return {
                    ...n,
                    workspace: trimmedCmdKQuery,
                  };
                });
                setCurrentWorkspace(trimmedCmdKQuery);
                setSelectedCmdKSuggestionIndex(0);
                setDatabase(newDatabase);
                setCmdKSearchQuery('');
                return false;
              },
            },
          ]
        : []),
      ...(currentNote?.workspace &&
      (!trimmedCmdKQuery || unlinkTitle.includes(trimmedCmdKQuery))
        ? [
            {
              type: cmdKSuggestionActionType,
              title: unlinkTitle,
              content: `-[${currentNote.workspace}]`,
              color: 'purple',
              onAction() {
                currentNote.workspace = undefined;
                setDatabase(sortNotes(database));
                setCurrentWorkspace(null);
                return false;
              },
            },
          ]
        : []),
    ];

    sortNotes(notes);

    return [
      ...notes.map((note) => ({
        type: 'note' as const,
        note,
      })),
      ...actions,
    ];
  }, [
    workspaceNotes,
    availableWorkspaces,
    cmdKSearchQuery,
    database,
    currentWorkspace,
    currentNoteId,
    setDatabase,
    setCurrentWorkspace,
    openNewNote,
    openNote,
  ]);

  const getNoteTitle = (note: Note) => {
    const firstLineBreakIndex = note.content.trim().indexOf('\n');
    const title = note.content.substring(
      0,
      firstLineBreakIndex === -1 ? undefined : firstLineBreakIndex + 1,
    );
    return title;
  };

  const saveNote = (noteId: string, newText: string) => {
    let processedText = newText;
    if (aceEditorRef.current) {
      const editor = aceEditorRef.current.editor;
      textsToReplace.forEach(([from, to]) => {
        if (from instanceof RegExp) {
          editor.replaceAll(to, {
            needle: from,
            regExp: true,
          });
        } else {
          editor.replaceAll(to, {
            needle: from,
            regExp: false,
          });
        }
      });
      processedText = editor.getValue();
    } else {
      textsToReplace.forEach(([from, to]) => {
        if (from instanceof RegExp) {
          processedText = processedText.replace(from, to);
        } else {
          processedText = processedText.split(from).join(to);
        }
      });
    }

    const noteIndex = database.findIndex((n) => n.id === noteId);
    if (noteIndex !== -1) {
      const updatedNote = {
        ...database[noteIndex],
        content: processedText,
        updatedAt: new Date().toISOString(),
      };
      const newDatabase = [...database];
      newDatabase.splice(noteIndex, 1, updatedNote);
      setDatabase(newDatabase);
    }
  };

  const runCmdKSuggestion = (suggestion?: CmdKSuggestion): boolean => {
    if (!suggestion) return true;
    if (suggestion.type === 'note') {
      openNote(suggestion.note.id);
      return true;
    } else if (suggestion.type === 'action') {
      return suggestion.onAction();
    }
    return false;
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // NO PRINT
      if (e.key === 'p' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
      }

      if (isCmdKMenuOpen && e.key === 'Escape') {
        e.preventDefault();
        setIsCmdKMenuOpen(false);
        focus();
        return;
      }

      const vimUp = (e.ctrlKey || e.metaKey) && e.key === 'k';
      const vimDown = (e.ctrlKey || e.metaKey) && e.key === 'j';
      const vimLeft = (e.ctrlKey || e.metaKey) && e.key === 'u';
      const vimRight = (e.ctrlKey || e.metaKey) && e.key === 'i';

      if (isCmdKMenuOpen && (vimUp || vimDown || vimLeft || vimRight)) {
        setHasVimNavigated(true);
      }

      if (isCmdKMenuOpen) {
        if (
          workspaceNotes.length > 1 &&
          selectedCmdKSuggestionIndex !== null &&
          e.key === 'Backspace' &&
          (e.ctrlKey || e.metaKey)
        ) {
          const suggestion = cmdKSuggestions[selectedCmdKSuggestionIndex];
          if (suggestion.type === 'note') {
            deleteNote(suggestion.note.id);
            setSelectedCmdKSuggestionIndex(
              Math.max(selectedCmdKSuggestionIndex - 1, 0),
            );
          }
          return;
        }

        if (
          freshlyDeletedNotes.length > 0 &&
          e.key === 'z' &&
          (e.ctrlKey || e.metaKey)
        ) {
          const topOfStack = freshlyDeletedNotes.pop();
          if (topOfStack) {
            e.stopImmediatePropagation();
            e.preventDefault();
            setDatabase(sortNotes([...database, topOfStack]));
          }
          return;
        }

        let nextIndex: number | null = null;
        const length = cmdKSuggestions.length;
        if (e.key === 'ArrowUp' || vimUp) {
          e.preventDefault();
          if (selectedCmdKSuggestionIndex === null) {
            nextIndex = length - 1;
          } else {
            nextIndex = (selectedCmdKSuggestionIndex - 1 + length) % length;
          }
          setSelectedCmdKSuggestionIndex(nextIndex);
        } else if (e.key === 'ArrowDown' || vimDown) {
          e.preventDefault();
          if (selectedCmdKSuggestionIndex === null) {
            nextIndex = 0;
          } else {
            nextIndex = (selectedCmdKSuggestionIndex + 1) % length;
          }
          setSelectedCmdKSuggestionIndex(nextIndex);
        }

        if (nextIndex !== null) {
          const elementId = `note-list-cmdk-item-${nextIndex}`;
          const element = document.getElementById(elementId);
          if (element) {
            element.scrollIntoView({ block: 'center' });
          }
          return;
        }

        if (e.key === 'Enter') {
          e.preventDefault();
          const suggestion = cmdKSuggestions[selectedCmdKSuggestionIndex];
          const shouldCloseCmdK = runCmdKSuggestion(suggestion);
          if (shouldCloseCmdK) {
            setIsCmdKMenuOpen(false);
            setSelectedCmdKSuggestionIndex(0);
          }
          return;
        }

        let nextWorkspaceIndex: number | null = null;
        const currentIndex = navigableWorkspaces.indexOf(currentWorkspace);
        if (currentIndex === -1) {
          console.warn('wtf?'); // not supposed to happen
        } else {
          if (vimLeft || e.key === 'ArrowLeft') {
            e.preventDefault();
            nextWorkspaceIndex =
              (currentIndex - 1 + navigableWorkspaces.length) %
              navigableWorkspaces.length;
          }

          if (vimRight || e.key === 'ArrowRight') {
            e.preventDefault();
            nextWorkspaceIndex =
              (currentIndex + 1) % navigableWorkspaces.length;
          }

          if (nextWorkspaceIndex !== null) {
            const nextWorkspace = navigableWorkspaces[nextWorkspaceIndex];
            if (nextWorkspace !== currentWorkspace) {
              setSelectedCmdKSuggestionIndex(0);
              setCurrentWorkspace(nextWorkspace);
            }
          }

          return;
        }

        return;
      }

      if (isHelpMenuOpen && (e.key === 'Escape' || e.key === 'Enter')) {
        e.preventDefault();
        setIsHelpMenuOpen((prev) => !prev);
        focus();
        return;
      }

      if ((e.key === 'p' || e.key === 'k') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        textareaDomRef.current?.blur();
        setSelectedCmdKSuggestionIndex(0);
        setIsCmdKMenuOpen(true);
        setIsHelpMenuOpen(false);
        setCmdKSearchQuery('');
        return;
      }

      if (
        e.key === 'Enter' &&
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        textValue.trim().length !== 0
      ) {
        e.preventDefault();
        openNewNote();
        return;
      }

      if (e.key === 'Enter') {
        focus();
      } else if (isUsingVim && !isCmdKMenuOpen) {
        if (document.activeElement === document.body) {
          aceEditorRef.current?.editor.focus();
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (
        hasVimNavigated &&
        isCmdKMenuOpen &&
        (event.key === 'Meta' || event.key === 'Control')
      ) {
        let shouldCloseCmdK: boolean = true;
        if (cmdKSuggestions.length > 0) {
          const suggestion = cmdKSuggestions[selectedCmdKSuggestionIndex];
          shouldCloseCmdK = runCmdKSuggestion(suggestion);
        }

        if (shouldCloseCmdK) {
          setIsCmdKMenuOpen(false);
        }

        setHasVimNavigated(false);

        focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    database,
    database.length,
    hasVimNavigated,
    isCmdKMenuOpen,
    openNewNote,
    openNote,
    selectedCmdKSuggestionIndex,
    textValue,
    isNarrowScreen,
    isHelpMenuOpen,
    isUsingVim,
    focus,
    cmdKSuggestions,
    setIsNarrowScreen,
    currentWorkspace,
    navigableWorkspaces,
    runCmdKSuggestion,
    setCurrentWorkspace,
  ]);

  useEffect(() => {
    if (textareaDomRef.current) {
      textareaDomRef.current.focus();
    }
  }, [currentNoteId]);

  const aceEditorRef = useRef<AceEditor>(null);

  useEffect(() => {
    if (isUsingVim && aceEditorRef.current) {
      const editor = aceEditorRef.current.editor;
      editor.commands.removeCommand('find');
      editor.getSession().setOption('indentedSoftWrap', false);
      editor.resize();
    }
  }, [isUsingVim]);

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const cmdKey = isMac ? '⌘' : 'ctrl';

  return (
    <main
      style={{
        ...(isNarrowScreen
          ? {
              maxWidth: '800px',
              margin: '0 auto',
            }
          : {}),
      }}
    >
      {isUsingVim ? (
        <div
          style={{
            padding: '2rem',
            width: '100%',
            paddingRight: '0',
            height: '100vh',
          }}
        >
          <AceEditor
            theme={currentTheme === 'dark' ? 'clouds_midnight' : 'clouds'}
            ref={aceEditorRef}
            value={textValue}
            onChange={(newText: string) => {
              setTextValue(newText);
              saveNote(currentNoteId, newText);
            }}
            setOptions={{
              showLineNumbers: false,
              showGutter: false,
              wrap: true,
              highlightActiveLine: false,
              showPrintMargin: false,
            }}
            fontSize="1.5rem"
            onCursorChange={(e) => {
              setLastAceCursorPosition({
                row: e.cursor.row,
                column: e.cursor.column,
              });
            }}
            tabSize={4}
            keyboardHandler="vim"
            width="100%"
            height="100%"
            className="editor"
            style={{
              lineHeight: '1.5',
              background: 'var(--note-background-color)',
              color: 'var(--dark-color)',
            }}
            placeholder="Type here..."
          />
        </div>
      ) : (
        <EnhancedTextarea
          id="editor"
          ref={textareaDomRef}
          setText={(newText) => {
            setTextValue(newText);
            saveNote(currentNoteId, newText);
          }}
          text={textValue}
          placeholder="Type here..."
        />
      )}
      <div id="controls">
        <button
          onClick={() => {
            setIsHelpMenuOpen(true);
          }}
        >
          ?
        </button>
        {isHelpMenuOpen &&
          createPortal(
            <>
              <div
                style={{
                  width: '100vw',
                  height: '100vh',
                  position: 'fixed',
                  background: 'var(--overlay-background-color)',
                  top: 0,
                  left: 0,
                  zIndex: 10,
                }}
                onClick={() => {
                  setIsHelpMenuOpen(false);
                }}
              />
              <div className="help-menu">
                <h3>Keyboard Shortcuts</h3>
                <div className="help-menu-shortcuts">
                  <div className="help-menu-shortcuts-item">
                    <div className="help-menu-shortcuts-keys">
                      <kbd>{cmdKey}</kbd>
                      <kbd>k/p</kbd>
                    </div>
                    <span>Open notes search</span>
                  </div>
                  <div className="help-menu-shortcuts-item">
                    <div className="help-menu-shortcuts-keys">
                      <kbd>{cmdKey}</kbd>
                      <kbd>m/slash</kbd>
                    </div>
                    <span>Open notes list</span>
                  </div>
                  <div className="help-menu-shortcuts-item">
                    <div className="help-menu-shortcuts-keys">
                      <kbd>{cmdKey}</kbd>
                      <kbd>⇧</kbd>
                      <kbd>⏎</kbd>
                    </div>
                    <span>Create empty note</span>
                  </div>
                  <div className="help-menu-shortcuts-item">
                    <div className="help-menu-shortcuts-keys">
                      <kbd>{cmdKey}</kbd>
                      <kbd>j/k</kbd>
                    </div>
                    or
                    <div className="help-menu-shortcuts-keys">
                      <kbd>↑/↓</kbd>
                    </div>
                    <span>Navigation</span>
                  </div>
                  <div className="help-menu-shortcuts-item">
                    <div className="help-menu-shortcuts-keys">
                      <kbd>{cmdKey}</kbd>
                      <kbd>i</kbd>
                    </div>
                    <span>Toggle narrow screen</span>
                  </div>
                </div>
                <button onClick={() => setIsHelpMenuOpen(false)}>close</button>
              </div>
            </>,
            document.body,
          )}
        <button
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMoreMenuPosition({
              x: window.innerWidth - (rect.x + rect.width),
              y: window.innerHeight - rect.y + 4,
            });
          }}
        >
          more
        </button>
        {moreMenuPosition && (
          <>
            <div
              style={{
                width: '100vw',
                height: '100vh',
                position: 'fixed',
                top: 0,
                left: 0,
              }}
              onClick={() => {
                setMoreMenuPosition(null);
              }}
            />
            <div
              style={{
                position: 'fixed',
                right: moreMenuPosition.x,
                bottom: moreMenuPosition.y,
                zIndex: 100,
              }}
              className="more-menu"
            >
              <button
                onClick={() => {
                  setMoreMenuPosition(null);
                  setIsUsingVim(!isUsingVim);
                }}
              >
                {isUsingVim ? 'no vim' : 'vim'}
              </button>
              <button
                onClick={() => {
                  setMoreMenuPosition(null);
                  toggleTheme();
                }}
              >
                {currentTheme === 'light' ? 'dark' : 'light'}
              </button>
              <button
                onClick={() => {
                  backupDataToSafeLocation(database);
                }}
              >
                backup
              </button>
              <button
                tabIndex={-1}
                onClick={() => {
                  const compressedData = LZString.compressToEncodedURIComponent(
                    JSON.stringify(database),
                  );
                  const dataStr =
                    'data:text/json;charset=utf-8,' + compressedData;
                  const downloadAnchorNode = document.createElement('a');
                  downloadAnchorNode.setAttribute('href', dataStr);
                  downloadAnchorNode.setAttribute(
                    'download',
                    'notes_export.json',
                  );
                  document.body.appendChild(downloadAnchorNode);
                  downloadAnchorNode.click();
                  downloadAnchorNode.remove();
                }}
              >
                export
              </button>
              <input
                type="file"
                style={{ display: 'none' }}
                ref={fileInputDomRef}
                onChange={(e) => {
                  const fileReader = new FileReader();
                  const target = e.target as HTMLInputElement;
                  if (!target.files) return;
                  fileReader.readAsText(target.files[0], 'UTF-8');
                  fileReader.onload = (e) => {
                    const decompressedContent =
                      LZString.decompressFromEncodedURIComponent(
                        e.target?.result as string,
                      );
                    if (decompressedContent) {
                      const content = JSON.parse(decompressedContent);
                      setDatabase(content);
                    }
                  };
                }}
              />
              <button
                tabIndex={-1}
                onClick={() => fileInputDomRef.current?.click()}
              >
                import
              </button>
            </div>
          </>
        )}
        {textValue && (
          <button tabIndex={-1} onClick={() => openNewNote('')}>
            new
          </button>
        )}
      </div>
      {isCmdKMenuOpen &&
        createPortal(
          <>
            <div
              style={{
                backgroundColor: 'var(--overlay-background-color)',
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
              }}
              onClick={() => {
                setIsCmdKMenuOpen(false);
              }}
            />
            <div
              style={{
                zIndex: 100,
                position: 'fixed',
                top: '25%',
                left: '50%',
                width: '240px',
                transform: 'translateX(-50%)',
                backgroundColor: 'var(--note-background-color)',
                boxShadow: '0 4px 6px var(--box-shadow-color)',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 6,
                border: '1px solid var(--border-color)',
              }}
            >
              <input
                autoFocus
                placeholder="Search for note"
                value={cmdKSearchQuery}
                onChange={(e) => {
                  setCmdKSearchQuery(e.target.value);
                  setSelectedCmdKSuggestionIndex(0);
                }}
                style={{
                  padding: '4px',
                  outline: 'none',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  margin: '6px',
                  marginBottom: 0,
                }}
              />
              <div
                className="notes-list no-scrollbar"
                style={{
                  maxHeight: '300px',
                  overflow: 'auto',
                  display: 'flex',
                  border: 'none',
                  flexDirection: 'column',
                  gap: 4,
                  padding: 4,
                }}
              >
                {cmdKSuggestions.map((suggestion, index) => {
                  if (suggestion.type === 'note') {
                    const note = suggestion.note;
                    const title = getNoteTitle(note);
                    const timestamp = new Date(note.updatedAt).toLocaleString();

                    return (
                      <div
                        key={note.id}
                        id={`note-list-cmdk-item-${index}`}
                        className="note-list-item"
                        onClick={() => {
                          openNote(note.id);
                        }}
                        style={{
                          backgroundColor:
                            index === selectedCmdKSuggestionIndex
                              ? 'var(--note-selected-background-color)'
                              : 'var(--note-background-color)',
                        }}
                      >
                        <div className="note-list-item-top">
                          <div
                            className="note-list-item-title"
                            style={{
                              fontWeight:
                                note.id === currentNoteId ? 'bold' : 'normal',
                              fontStyle: title ? 'normal' : 'italic',
                              color: title
                                ? 'var(--dark-color)'
                                : 'var(--untitled-note-title-color)',
                            }}
                          >
                            {title || 'New Note'}
                          </div>
                          <button
                            className="note-list-item-delete-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteNote(note.id);
                            }}
                            style={{
                              visibility:
                                workspaceNotes.length > 1 &&
                                index === selectedCmdKSuggestionIndex
                                  ? 'visible'
                                  : 'hidden',
                              pointerEvents:
                                workspaceNotes.length > 1 &&
                                index === selectedCmdKSuggestionIndex
                                  ? 'auto'
                                  : 'none',
                            }}
                          >
                            Delete
                          </button>
                        </div>
                        <div
                          className="note-list-item-timestamp"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                        >
                          <span>{timestamp}</span>
                          {!currentWorkspace && note.workspace && (
                            <>
                              <span>•</span>
                              <span
                                style={{
                                  overflow: 'hidden',
                                  whiteSpace: 'nowrap',
                                  textOverflow: 'ellipsis',
                                  direction: 'rtl',
                                }}
                              >
                                {note.workspace}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  }

                  const { title, onAction, content, color } = suggestion;

                  return (
                    <div
                      id={`note-list-cmdk-item-${index}`}
                      className="note-list-item"
                      onClick={onAction}
                      style={{
                        backgroundColor:
                          index === selectedCmdKSuggestionIndex
                            ? 'var(--note-selected-background-color)'
                            : 'var(--note-background-color)',
                        position: 'relative',
                      }}
                    >
                      {color && (
                        <div
                          style={{
                            top: 2,
                            bottom: 2,
                            left: 0,
                            width: 3,
                            borderRadius: 4,
                            position: 'absolute',
                            background: color,
                            opacity:
                              index === selectedCmdKSuggestionIndex ? 1.0 : 0.5,
                          }}
                        ></div>
                      )}
                      <div className="note-list-item-top">
                        <div
                          className="note-list-item-title"
                          style={{
                            fontWeight: 'normal',
                            fontStyle: 'normal',
                            color: 'var(--dark-color)',
                          }}
                        >
                          {title}
                        </div>
                        <p
                          style={{
                            marginLeft: '4px',
                            fontSize: '0.8rem',
                            display: 'flex',
                            alignItems: 'center',
                            padding: '2px 4px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            color: 'var(--on-fill-color)',
                            background: 'var(--keyboard-key-color)',
                            visibility:
                              index === selectedCmdKSuggestionIndex
                                ? 'visible'
                                : 'hidden',
                          }}
                        >
                          Enter{' '}
                          <span
                            style={{
                              marginLeft: '4px',
                              marginBottom: '1px',
                            }}
                          >
                            ↵
                          </span>
                        </p>
                      </div>
                      <div
                        className="note-list-item-timestamp"
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <p>{content}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  outline: 'none',
                  padding: '4px 8px',
                  fontSize: '0.75rem',
                  borderTop: '1px solid var(--border-color)',
                  color: 'var(--dark-color)',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  opacity: 0.6,
                }}
              >
                {currentWorkspace
                  ? `workspace: [${currentWorkspace}]`
                  : `all notes`}
              </div>
            </div>
          </>,
          document.body,
        )}
    </main>
  );
}

export default App;
