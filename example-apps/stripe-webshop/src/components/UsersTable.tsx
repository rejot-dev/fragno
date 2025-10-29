import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CheckIcon, ChevronsUpDownIcon, PencilIcon } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import type { UserWithRole } from "better-auth/plugins";
import { useState } from "react";
import { stripeClient } from "@/lib/stripe.client";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";

type UserWithSubscription = UserWithRole & { stripeCustomerId: string };

export function UsersTable() {
  const queryClient = useQueryClient();
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [updating, setUpdating] = useState(false);
  const [comboboxOpen, setComboboxOpen] = useState(false);

  const { data: stripeCustomers } = stripeClient.useCustomers();

  const {
    data: users = [],
    error,
    isLoading,
  } = useQuery<UserWithSubscription[]>({
    queryKey: ["users"],
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUsers({
        query: {
          limit: 100,
        },
      });

      if (error) {
        throw error;
      }

      return data.users as UserWithSubscription[];
    },
    retry: false,
  });

  const handleStartEdit = (userId: string, currentCustomerId?: string) => {
    setEditingUserId(userId);
    setSelectedCustomerId(currentCustomerId || "");
  };

  const handleCancelEdit = () => {
    setEditingUserId(null);
    setSelectedCustomerId("");
    setComboboxOpen(false);
  };

  const handleSaveLink = async (userId: string) => {
    if (!selectedCustomerId) {
      return;
    }

    setUpdating(true);
    try {
      const { error } = await authClient.admin.updateUser({
        userId,
        data: {
          stripeCustomerId: selectedCustomerId,
        },
      });

      if (error) {
        console.error("Failed to update user:", error);
        alert("Failed to link customer. Please try again.");
      } else {
        // Update React Query cache
        queryClient.setQueryData<UserWithSubscription[]>(["users"], (oldUsers) =>
          oldUsers?.map((user) =>
            user.id === userId ? { ...user, stripeCustomerId: selectedCustomerId } : user,
          ),
        );
        setEditingUserId(null);
        setSelectedCustomerId("");
        setComboboxOpen(false);
      }
    } catch (err) {
      console.error("Error updating user:", err);
      alert("An error occurred. Please try again.");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users Overview</CardTitle>
        <CardDescription>View all users in the database</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-muted-foreground py-8 text-center">Loading users...</div>
        ) : error ? (
          <div className="py-8 text-center text-red-600">Failed to load users: {error.message}</div>
        ) : users.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">No users found.</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Id</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Stripe Customer ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <span className="text-sm">{user.id}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{user.name}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{user.email}</span>
                    </TableCell>
                    <TableCell>
                      {editingUserId === user.id ? (
                        <div className="flex items-center gap-2">
                          <Popover open={comboboxOpen} onOpenChange={setComboboxOpen}>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                role="combobox"
                                aria-expanded={comboboxOpen}
                                className="w-[250px] justify-between"
                                disabled={updating}
                              >
                                {selectedCustomerId
                                  ? stripeCustomers?.customers.find(
                                      (customer) => customer.id === selectedCustomerId,
                                    )?.email ||
                                    stripeCustomers?.customers.find(
                                      (customer) => customer.id === selectedCustomerId,
                                    )?.name ||
                                    selectedCustomerId
                                  : "Select customer..."}
                                <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[250px] p-0">
                              <Command>
                                <CommandInput placeholder="Search customer..." />
                                <CommandList>
                                  <CommandEmpty>No customer found.</CommandEmpty>
                                  <CommandGroup>
                                    {stripeCustomers?.customers.map((customer) => (
                                      <CommandItem
                                        key={customer.id}
                                        value={customer.id}
                                        onSelect={(currentValue) => {
                                          setSelectedCustomerId(
                                            currentValue === selectedCustomerId ? "" : currentValue,
                                          );
                                          setComboboxOpen(false);
                                        }}
                                      >
                                        <CheckIcon
                                          className={cn(
                                            "mr-2 h-4 w-4",
                                            selectedCustomerId === customer.id
                                              ? "opacity-100"
                                              : "opacity-0",
                                          )}
                                        />
                                        {customer.email || customer.name || customer.id}
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          <Button
                            size="sm"
                            onClick={() => handleSaveLink(user.id)}
                            disabled={updating || !selectedCustomerId}
                          >
                            {updating ? "Saving..." : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleCancelEdit}
                            disabled={updating}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {user.stripeCustomerId ? (
                            <span className="font-mono text-xs">{user.stripeCustomerId}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleStartEdit(user.id, user.stripeCustomerId)}
                            className="h-6 w-6 p-0"
                          >
                            <PencilIcon className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
